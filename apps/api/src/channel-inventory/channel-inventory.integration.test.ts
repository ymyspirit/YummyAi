import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  channelAllocationPolicyVersions,
  channelAllocationRuns,
  channelAvailabilityProjections,
  channelMutationReconciliationEvents,
  connectDatabase,
  inventoryStockItems,
  marketplaceAccounts,
  migrateDatabase,
  networkInventoryConnectorCheckpoints,
  networkInventorySnapshotLines,
  networkInventorySnapshots,
  withTenant,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ChannelInventoryService } from "./channel-inventory.service.js";

describe.sequential("channel inventory and availability", () => {
  const database = connectDatabase();
  const tenantA = createEntityId();
  const tenantB = createEntityId();
  const userA = createEntityId();
  const userB = createEntityId();
  const accountA = createEntityId();
  const accountB = createEntityId();
  const accountOtherTenant = createEntityId();
  const contextA = tenantContext(tenantA, userA);
  const contextB = tenantContext(tenantB, userB);
  const inventory = new InventoryService(database, new AuditService(database));
  const service = new ChannelInventoryService(database, new AuditService(database));

  let stockItemId: string;
  let warehouseId: string;
  let locationId: string;
  let policyId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1,$2,$3),($4,$5,$6)`,
      [
        tenantA, "Channel Inventory A", `channel-inventory-a-${tenantA}`,
        tenantB, "Channel Inventory B", `channel-inventory-b-${tenantB}`,
      ],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)`,
      [
        userA, `channel-inventory-a-${userA}`, `channel-a-${userA}@example.test`, "Channel A",
        userB, `channel-inventory-b-${userB}`, `channel-b-${userB}@example.test`, "Channel B",
      ],
    );
    const productPlanId = createEntityId();
    const spuId = createEntityId();
    const skuId = createEntityId();
    const customization = JSON.stringify({ version: 1, fields: [] });
    await database.client.unsafe(
      `insert into product_plans (id, tenant_id, name, customization)
       values ($1,$2,$3,$4::jsonb)`,
      [productPlanId, tenantA, "Channel allocation product", customization],
    );
    await database.client.unsafe(
      `insert into spus (id, tenant_id, product_plan_id, code, name, customization)
       values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [spuId, tenantA, productPlanId, "CHANNEL-PRODUCT", "Channel product", customization],
    );
    await database.client.unsafe(
      `insert into skus (id, tenant_id, spu_id, code, status)
       values ($1,$2,$3,$4,'active')`,
      [skuId, tenantA, spuId, "CHANNEL-SKU"],
    );
    await database.client.unsafe(
      `insert into marketplace_accounts
       (id, tenant_id, platform, display_name, external_account_id, region, marketplace_ids, authorization_mode, status)
       values
       ($1,$2,'etsy','Etsy A','etsy-a','GLOBAL',$3::jsonb,'etsy_oauth','active'),
       ($4,$2,'etsy','Etsy B','etsy-b','GLOBAL',$3::jsonb,'etsy_oauth','active'),
       ($5,$6,'etsy','Other tenant','etsy-other','GLOBAL',$3::jsonb,'etsy_oauth','active')`,
      [accountA, tenantA, JSON.stringify(["US"]), accountB, accountOtherTenant, tenantB],
    );
    const warehouse = await inventory.createWarehouse(contextA, {
      code: "NETWORK",
      name: "Network warehouse",
      type: "third_party",
      countryCode: "US",
      timeZone: "America/Los_Angeles",
    });
    warehouseId = warehouse.id;
    locationId = (await inventory.createLocation(contextA, {
      warehouseId,
      code: "NETWORK-A",
      name: "Network location",
    })).id;
    stockItemId = (await inventory.createStockItem(contextA, {
      skuId,
      code: "CHANNEL-SKU",
      name: "Channel SKU",
      baseUnit: "each",
    })).id;
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("records immutable source and condition dimensions with monotonic checkpoints", async () => {
    const input = snapshotInput({
      checkpointSequence: 1,
      idempotencyKey: "channel-snapshot-0001",
    });
    const first = await service.recordSnapshot(contextA, input);
    const replay = await service.recordSnapshot(contextA, input);

    expect(replay.id).toBe(first.id);
    expect(first.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "owned", condition: "sellable", quantity: 100 }),
      expect.objectContaining({ source: "owned", condition: "quarantine", quantity: 20 }),
      expect.objectContaining({ source: "owned", condition: "damaged", quantity: 10 }),
      expect.objectContaining({ source: "in_transit", condition: "sellable", quantity: 30 }),
      expect.objectContaining({ source: "virtual", condition: "sellable", quantity: 40 }),
    ]));
    await expect(service.recordSnapshot(contextA, {
      ...input,
      lines: input.lines.map((line, index) =>
        index === 0 ? { ...line, quantity: line.quantity + 1 } : line),
    })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.recordSnapshot(contextA, {
      ...input,
      idempotencyKey: "channel-snapshot-stale-0001",
    })).rejects.toBeInstanceOf(ConflictException);
    expect(await withTenant(database.db, contextA, (tx) =>
      tx.select().from(networkInventoryConnectorCheckpoints),
    )).toHaveLength(1);
  });

  it("versions policies and allocates caps, buffers, and priorities without oversubscription", async () => {
    const policy = await service.upsertPolicy(contextA, {
      policyId: null,
      stockItemId,
      name: "Primary channel allocation",
      eligibleSources: ["owned"],
      allowVirtual: false,
      safetyBufferQuantity: 10,
      channels: [
        {
          accountId: accountA,
          platform: "etsy",
          marketplaceId: "US",
          listingId: null,
          priority: 1,
          capQuantity: 60,
          bufferQuantity: 5,
        },
        {
          accountId: accountB,
          platform: "etsy",
          marketplaceId: "US",
          listingId: null,
          priority: 2,
          capQuantity: null,
          bufferQuantity: 10,
        },
      ],
      reasonCode: "INITIAL_POLICY",
      idempotencyKey: "channel-policy-0001",
    });
    policyId = policy.id;
    const run = await service.runAllocation(contextA, {
      policyId,
      expectedPolicyVersion: 1,
      idempotencyKey: "channel-allocation-run-0001",
    });

    expect(run).toMatchObject({
      policyVersion: 1,
      eligibleQuantity: 100,
      allocatableQuantity: 90,
      allocatedQuantity: 75,
    });
    expect(run.projections).toEqual([
      expect.objectContaining({
        accountId: accountA,
        priority: 1,
        capQuantity: 60,
        bufferQuantity: 5,
        allocatedQuantity: 55,
      }),
      expect.objectContaining({
        accountId: accountB,
        priority: 2,
        capQuantity: null,
        bufferQuantity: 10,
        allocatedQuantity: 20,
      }),
    ]);
    expect(run.projections.reduce((total, projection) =>
      total + projection.allocatedQuantity, 0)).toBeLessThanOrEqual(run.allocatableQuantity);
    const replay = await service.runAllocation(contextA, {
      policyId,
      expectedPolicyVersion: 1,
      idempotencyKey: "channel-allocation-run-0001",
    });
    expect(replay.id).toBe(run.id);
    await expect(service.runAllocation(contextA, {
      policyId,
      expectedPolicyVersion: 2,
      idempotencyKey: "channel-allocation-run-0001",
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it("fails closed when a Listing quantity exceeds or lacks a current allocation", async () => {
    await expect(withTenant(database.db, contextA, (tx) =>
      service.assertMarketplaceAllocations(tx, {
        accountId: accountA,
        platform: "etsy",
        marketplaceId: "US",
        listingId: createEntityId(),
        desired: [{ skuCode: "CHANNEL-SKU", quantity: 55 }],
      }),
    )).resolves.toBeUndefined();
    await expect(withTenant(database.db, contextA, (tx) =>
      service.assertMarketplaceAllocations(tx, {
        accountId: accountA,
        platform: "etsy",
        marketplaceId: "US",
        listingId: createEntityId(),
        desired: [{ skuCode: "CHANNEL-SKU", quantity: 56 }],
      }),
    )).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(withTenant(database.db, contextA, (tx) =>
      service.assertMarketplaceAllocations(tx, {
        accountId: accountA,
        platform: "etsy",
        marketplaceId: "CA",
        listingId: createEntityId(),
        desired: [{ skuCode: "CHANNEL-SKU", quantity: 1 }],
      }),
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it("keeps virtual, in-transit, quarantine, and damaged stock explicit across policy versions", async () => {
    const revised = await service.upsertPolicy(contextA, {
      policyId,
      stockItemId,
      name: "Primary channel allocation",
      eligibleSources: ["owned", "virtual"],
      allowVirtual: true,
      safetyBufferQuantity: 10,
      channels: [{
        accountId: accountA,
        platform: "etsy",
        marketplaceId: "US",
        listingId: null,
        priority: 1,
        capQuantity: null,
        bufferQuantity: 0,
      }],
      reasonCode: "ENABLE_VIRTUAL",
      idempotencyKey: "channel-policy-0002",
    });
    expect(revised.currentVersion).toBe(2);
    const run = await service.runAllocation(contextA, {
      policyId,
      expectedPolicyVersion: 2,
      idempotencyKey: "channel-allocation-run-0002",
    });
    expect(run).toMatchObject({
      eligibleQuantity: 140,
      allocatableQuantity: 130,
      allocatedQuantity: 130,
    });
    expect(run.projections[0]!.sourceTrace).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "owned", condition: "sellable", quantity: 100 }),
      expect.objectContaining({ source: "virtual", condition: "sellable", quantity: 40 }),
    ]));
    expect(run.projections[0]!.sourceTrace).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "in_transit" }),
      expect.objectContaining({ condition: "quarantine" }),
      expect.objectContaining({ condition: "damaged" }),
    ]));
    expect(await withTenant(database.db, contextA, (tx) =>
      tx.select().from(channelAllocationPolicyVersions)
        .where(eq(channelAllocationPolicyVersions.policyId, policyId)),
    )).toHaveLength(2);
  });

  it("invalidates projections when newer provider evidence arrives", async () => {
    await service.recordSnapshot(contextA, snapshotInput({
      checkpointSequence: 2,
      idempotencyKey: "channel-snapshot-0002",
      sellableOwnedQuantity: 80,
    }));
    await expect(withTenant(database.db, contextA, (tx) =>
      service.assertMarketplaceAllocations(tx, {
        accountId: accountA,
        platform: "etsy",
        marketplaceId: "US",
        listingId: createEntityId(),
        desired: [{ skuCode: "CHANNEL-SKU", quantity: 1 }],
      }),
    )).rejects.toBeInstanceOf(ConflictException);
    const refreshed = await service.runAllocation(contextA, {
      policyId,
      expectedPolicyVersion: 2,
      idempotencyKey: "channel-allocation-run-0003",
    });
    expect(refreshed.eligibleQuantity).toBe(120);
  });

  it("records unknown provider mutations as append-only reconciliation evidence", async () => {
    const openInput = {
      accountId: accountA,
      listingId: null,
      syncRequestId: null,
      mutationKey: "etsy-listing-1-inventory",
      reasonCode: "PROVIDER_RESULT_UNKNOWN",
      message: "Provider timed out after accepting the request",
      idempotencyKey: "channel-reconciliation-0001",
    };
    const opened = await service.recordReconciliation(contextA, openInput);
    expect(opened.status).toBe("open");
    expect((await service.recordReconciliation(contextA, openInput)).id).toBe(opened.id);
    await expect(service.recordReconciliation(contextA, {
      ...openInput,
      reasonCode: "PROVIDER_RESPONSE_LOST",
    })).rejects.toBeInstanceOf(ConflictException);
    const resolutionInput = {
      outcome: "confirmed",
      reasonCode: "PROVIDER_READ_CONFIRMED",
      idempotencyKey: "channel-reconciliation-resolution-0001",
    } as const;
    const resolved = await service.resolveReconciliation(contextA, opened.id, resolutionInput);
    expect(resolved.status).toBe("confirmed");
    expect((await service.resolveReconciliation(contextA, opened.id, resolutionInput)).status).toBe("confirmed");
    await expect(service.resolveReconciliation(contextA, opened.id, {
      ...resolutionInput,
      outcome: "rejected",
    })).rejects.toBeInstanceOf(ConflictException);
    const events = await withTenant(database.db, contextA, (tx) =>
      tx.select().from(channelMutationReconciliationEvents)
        .where(eq(channelMutationReconciliationEvents.reconciliationId, opened.id)),
    );
    expect(events).toHaveLength(2);
  });

  it("isolates tenant identifiers and denies mutation of append-only evidence", async () => {
    await expect(service.recordSnapshot(contextB, {
      ...snapshotInput({
        checkpointSequence: 1,
        idempotencyKey: "channel-cross-tenant-snapshot-0001",
      }),
      accountId: accountOtherTenant,
    })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.upsertPolicy(contextA, {
      policyId,
      stockItemId,
      name: "Cross tenant target",
      eligibleSources: ["owned"],
      allowVirtual: false,
      safetyBufferQuantity: 0,
      channels: [{
        accountId: accountOtherTenant,
        platform: "etsy",
        marketplaceId: "US",
        listingId: null,
        priority: 1,
        capQuantity: null,
        bufferQuantity: 0,
      }],
      reasonCode: "INVALID_TARGET",
      idempotencyKey: "channel-cross-tenant-policy-0001",
    })).rejects.toBeInstanceOf(NotFoundException);
    const [snapshot] = await withTenant(database.db, contextA, (tx) =>
      tx.select().from(networkInventorySnapshots).limit(1),
    );
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(networkInventorySnapshots).set({ scopeKey: "tampered" })
        .where(eq(networkInventorySnapshots.id, snapshot!.id)),
    )).rejects.toThrow();
    const [run] = await withTenant(database.db, contextA, (tx) =>
      tx.select().from(channelAllocationRuns).limit(1),
    );
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(channelAllocationRuns).set({ eligibleQuantity: 999 })
        .where(eq(channelAllocationRuns.id, run!.id)),
    )).rejects.toThrow();

    const [privileges] = await withTenant(database.db, contextA, (tx) => tx.execute<{
      snapshot_update: boolean;
      line_delete: boolean;
      checkpoint_update: boolean;
      policy_version_update: boolean;
      run_update: boolean;
      projection_delete: boolean;
      reconciliation_event_update: boolean;
    }>(sql`
      select
        has_table_privilege(current_user, 'network_inventory_snapshots', 'UPDATE') as snapshot_update,
        has_table_privilege(current_user, 'network_inventory_snapshot_lines', 'DELETE') as line_delete,
        has_table_privilege(current_user, 'network_inventory_connector_checkpoints', 'UPDATE') as checkpoint_update,
        has_table_privilege(current_user, 'channel_allocation_policy_versions', 'UPDATE') as policy_version_update,
        has_table_privilege(current_user, 'channel_allocation_runs', 'UPDATE') as run_update,
        has_table_privilege(current_user, 'channel_availability_projections', 'DELETE') as projection_delete,
        has_table_privilege(current_user, 'channel_mutation_reconciliation_events', 'UPDATE') as reconciliation_event_update
    `));
    expect(privileges).toEqual({
      snapshot_update: false,
      line_delete: false,
      checkpoint_update: false,
      policy_version_update: false,
      run_update: false,
      projection_delete: false,
      reconciliation_event_update: false,
    });
  });

  it("exposes a traceable workspace without leaking another tenant", async () => {
    const workspace = await service.workspace(contextA);
    expect(workspace.snapshots.length).toBeGreaterThanOrEqual(2);
    expect(workspace.policies).toHaveLength(1);
    expect(workspace.runs.length).toBeGreaterThanOrEqual(3);
    expect(workspace.reconciliations).toHaveLength(1);
    await expect(service.workspace(contextB)).resolves.toEqual({
      stockItems: [],
      accounts: [expect.objectContaining({ id: accountOtherTenant })],
      snapshots: [],
      policies: [],
      runs: [],
      reconciliations: [],
    });
    expect(await withTenant(database.db, contextA, (tx) =>
      tx.select().from(networkInventorySnapshotLines),
    )).not.toHaveLength(0);
    expect(await withTenant(database.db, contextA, (tx) =>
      tx.select().from(channelAvailabilityProjections),
    )).not.toHaveLength(0);
    expect(await withTenant(database.db, contextA, (tx) =>
      tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, stockItemId)),
    )).toHaveLength(1);
    expect(await withTenant(database.db, contextA, (tx) =>
      tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountA)),
    )).toHaveLength(1);
  });

  function snapshotInput({
    checkpointSequence,
    idempotencyKey,
    sellableOwnedQuantity = 100,
  }: {
    checkpointSequence: number;
    idempotencyKey: string;
    sellableOwnedQuantity?: number;
  }) {
    return {
      accountId: accountA,
      provider: "etsy" as const,
      scopeKey: "etsy-a:US",
      providerSnapshotId: `provider-snapshot-${checkpointSequence}`,
      checkpointSequence,
      checkpointCursor: `cursor-${checkpointSequence}`,
      observedAt: `2026-07-23T0${checkpointSequence}:00:00.000Z`,
      idempotencyKey,
      lines: [
        networkLine("owned", "sellable", sellableOwnedQuantity),
        networkLine("owned", "quarantine", 20),
        networkLine("owned", "damaged", 10),
        networkLine("in_transit", "sellable", 30),
        networkLine("virtual", "sellable", 40),
      ],
    };
  }

  function networkLine(
    source: "owned" | "in_transit" | "virtual",
    condition: "sellable" | "quarantine" | "damaged",
    quantity: number,
  ) {
    return {
      stockItemId,
      warehouseId,
      locationId,
      externalSku: "CHANNEL-SKU",
      source,
      condition,
      quantity,
      unit: "each" as const,
    };
  }
});

function tenantContext(tenantId: string, userId: string): TenantContext {
  return {
    tenantId,
    userId,
    permissions: [
      "inventory:read",
      "inventory:write",
      "channel_inventory:read",
      "channel_inventory:write",
      "channel_inventory:reconcile",
    ],
    dataScope: "tenant",
  };
}
