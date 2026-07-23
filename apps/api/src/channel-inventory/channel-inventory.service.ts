import { createHash } from "node:crypto";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ChannelAllocationPolicyViewSchema,
  ChannelAllocationRunViewSchema,
  ChannelInventoryWorkspaceViewSchema,
  ChannelMutationReconciliationViewSchema,
  NetworkInventorySnapshotViewSchema,
  RecordChannelMutationReconciliationInputSchema,
  RecordNetworkInventorySnapshotInputSchema,
  ResolveChannelMutationReconciliationInputSchema,
  RunChannelAllocationInputSchema,
  UpsertChannelAllocationPolicyInputSchema,
  type ChannelAllocationPolicyView,
  type ChannelAllocationRunView,
  type ChannelInventoryWorkspaceView,
  type ChannelMutationReconciliationView,
  type NetworkInventorySnapshotView,
  type RecordChannelMutationReconciliationInput,
  type RecordNetworkInventorySnapshotInput,
  type ResolveChannelMutationReconciliationInput,
  type RunChannelAllocationInput,
  type UpsertChannelAllocationPolicyInput,
} from "@yummyai/contracts/channel-inventory";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  channelAllocationPolicies,
  channelAllocationPolicyVersions,
  channelAllocationRuns,
  channelAvailabilityProjections,
  channelMutationReconciliationEvents,
  channelMutationReconciliations,
  inventoryLocations,
  inventoryStockItems,
  inventoryWarehouses,
  listings,
  marketplaceAccounts,
  networkInventoryConnectorCheckpoints,
  networkInventorySnapshotLines,
  networkInventorySnapshots,
  skus,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

type SnapshotRow = typeof networkInventorySnapshots.$inferSelect;
type PolicyRow = typeof channelAllocationPolicies.$inferSelect;
type RunRow = typeof channelAllocationRuns.$inferSelect;
type ReconciliationRow = typeof channelMutationReconciliations.$inferSelect;

@Injectable()
export class ChannelInventoryService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async recordSnapshot(
    context: TenantContext,
    rawInput: RecordNetworkInventorySnapshotInput,
  ): Promise<NetworkInventorySnapshotView> {
    const input = RecordNetworkInventorySnapshotInputSchema.parse(rawInput);
    const normalizedLines = [...input.lines].sort((left, right) =>
      stableStringify(left).localeCompare(stableStringify(right)));
    const inputChecksum = checksum({
      accountId: input.accountId,
      provider: input.provider,
      scopeKey: input.scopeKey,
      providerSnapshotId: input.providerSnapshotId,
      checkpointSequence: input.checkpointSequence,
      checkpointCursor: input.checkpointCursor,
      observedAt: input.observedAt,
      lines: normalizedLines,
    });
    const snapshot = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `network-inventory:${context.tenantId}:${input.provider}:${input.scopeKey}`);
      const [replayed] = await tx.select().from(networkInventorySnapshots)
        .where(eq(networkInventorySnapshots.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.checksum !== inputChecksum) {
          throw new ConflictException("Network inventory snapshot idempotency key was reused with different evidence");
        }
        return replayed;
      }
      await validateSnapshotReferences(tx, input);
      const [latestCheckpoint] = await tx.select().from(networkInventoryConnectorCheckpoints)
        .where(and(
          eq(networkInventoryConnectorCheckpoints.provider, input.provider),
          eq(networkInventoryConnectorCheckpoints.scopeKey, input.scopeKey),
        ))
        .orderBy(desc(networkInventoryConnectorCheckpoints.sequence))
        .limit(1);
      if (latestCheckpoint && input.checkpointSequence <= latestCheckpoint.sequence) {
        throw new ConflictException("Network inventory checkpoint sequence must advance");
      }
      const [created] = await tx.insert(networkInventorySnapshots).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        accountId: input.accountId,
        provider: input.provider,
        scopeKey: input.scopeKey,
        providerSnapshotId: input.providerSnapshotId,
        observedAt: new Date(input.observedAt),
        checksum: inputChecksum,
        idempotencyKey: input.idempotencyKey,
        recordedBy: context.userId,
      }).returning();
      await tx.insert(networkInventorySnapshotLines).values(normalizedLines.map((line, index) => ({
        id: createEntityId(),
        tenantId: context.tenantId,
        snapshotId: created!.id,
        lineNumber: index + 1,
        stockItemId: line.stockItemId,
        warehouseId: line.warehouseId,
        locationId: line.locationId,
        externalSku: line.externalSku,
        source: line.source,
        condition: line.condition,
        quantity: line.quantity,
        unit: line.unit,
      })));
      await tx.insert(networkInventoryConnectorCheckpoints).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        snapshotId: created!.id,
        accountId: input.accountId,
        provider: input.provider,
        scopeKey: input.scopeKey,
        sequence: input.checkpointSequence,
        cursor: input.checkpointCursor,
        observedAt: new Date(input.observedAt),
      });
      return created!;
    });
    const view = await this.getSnapshot(context, snapshot.id);
    await this.audit.record(context, {
      action: "channel_inventory.snapshot.record",
      resourceType: "network_inventory_snapshot",
      resourceId: view.id,
      result: "success",
      metadata: {
        provider: view.provider,
        scopeKey: view.scopeKey,
        checkpointSequence: view.checkpointSequence,
        lineCount: view.lines.length,
      },
    });
    return view;
  }

  async getSnapshot(context: TenantContext, snapshotId: string): Promise<NetworkInventorySnapshotView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [snapshot] = await tx.select().from(networkInventorySnapshots)
        .where(eq(networkInventorySnapshots.id, snapshotId)).limit(1);
      if (!snapshot) throw new NotFoundException("Network inventory snapshot not found");
      return snapshotView(tx, snapshot);
    });
  }

  async upsertPolicy(
    context: TenantContext,
    rawInput: UpsertChannelAllocationPolicyInput,
  ): Promise<ChannelAllocationPolicyView> {
    const input = UpsertChannelAllocationPolicyInputSchema.parse(rawInput);
    const versionChecksum = checksum({
      eligibleSources: [...input.eligibleSources].sort(),
      allowVirtual: input.allowVirtual,
      safetyBufferQuantity: input.safetyBufferQuantity,
      channels: canonicalChannels(input.channels),
      reasonCode: input.reasonCode,
    });
    const policy = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `channel-allocation-policy:${context.tenantId}:${input.stockItemId}`);
      const [replayed] = await tx.select().from(channelAllocationPolicyVersions)
        .where(eq(channelAllocationPolicyVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.checksum !== versionChecksum) {
          throw new ConflictException("Channel allocation policy idempotency key was reused with different rules");
        }
        const [existingPolicy] = await tx.select().from(channelAllocationPolicies)
          .where(eq(channelAllocationPolicies.id, replayed.policyId)).limit(1);
        if (!existingPolicy) throw new ConflictException("Channel allocation policy is missing");
        return existingPolicy;
      }
      await validatePolicyReferences(tx, input);
      let existing: PolicyRow | undefined;
      if (input.policyId) {
        [existing] = await tx.select().from(channelAllocationPolicies)
          .where(eq(channelAllocationPolicies.id, input.policyId)).limit(1);
        if (!existing) throw new NotFoundException("Channel allocation policy not found");
        if (existing.stockItemId !== input.stockItemId) {
          throw new ConflictException("Channel allocation policy stock item cannot change");
        }
      } else {
        [existing] = await tx.select().from(channelAllocationPolicies)
          .where(eq(channelAllocationPolicies.stockItemId, input.stockItemId)).limit(1);
        if (existing) {
          throw new ConflictException("A channel allocation policy already exists for this stock item");
        }
      }
      const nextVersion = (existing?.currentVersion ?? 0) + 1;
      const policyId = existing?.id ?? createEntityId();
      if (!existing) {
        [existing] = await tx.insert(channelAllocationPolicies).values({
          id: policyId,
          tenantId: context.tenantId,
          stockItemId: input.stockItemId,
          name: input.name,
          currentVersion: nextVersion,
          createdBy: context.userId,
        }).returning();
      }
      await tx.insert(channelAllocationPolicyVersions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        policyId,
        versionNumber: nextVersion,
        eligibleSources: [...input.eligibleSources].sort(),
        allowVirtual: input.allowVirtual,
        safetyBufferQuantity: input.safetyBufferQuantity,
        channels: canonicalChannels(input.channels),
        reasonCode: input.reasonCode,
        checksum: versionChecksum,
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      });
      if (existing.currentVersion !== nextVersion || existing.name !== input.name) {
        [existing] = await tx.update(channelAllocationPolicies).set({
          name: input.name,
          currentVersion: nextVersion,
          updatedAt: new Date(),
        }).where(eq(channelAllocationPolicies.id, policyId)).returning();
      }
      return existing!;
    });
    const view = await this.getPolicy(context, policy.id);
    await this.audit.record(context, {
      action: "channel_inventory.policy.version",
      resourceType: "channel_allocation_policy",
      resourceId: view.id,
      result: "success",
      metadata: { stockItemId: view.stockItemId, version: view.currentVersion },
    });
    return view;
  }

  async getPolicy(context: TenantContext, policyId: string): Promise<ChannelAllocationPolicyView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [policy] = await tx.select().from(channelAllocationPolicies)
        .where(eq(channelAllocationPolicies.id, policyId)).limit(1);
      if (!policy) throw new NotFoundException("Channel allocation policy not found");
      return policyView(tx, policy);
    });
  }

  async runAllocation(
    context: TenantContext,
    rawInput: RunChannelAllocationInput,
  ): Promise<ChannelAllocationRunView> {
    const input = RunChannelAllocationInputSchema.parse(rawInput);
    const run = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `channel-allocation-run:${context.tenantId}:${input.policyId}`);
      const [replayed] = await tx.select().from(channelAllocationRuns)
        .where(eq(channelAllocationRuns.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        const [replayedVersion] = await tx.select().from(channelAllocationPolicyVersions)
          .where(eq(channelAllocationPolicyVersions.id, replayed.policyVersionId)).limit(1);
        if (
          replayed.policyId !== input.policyId
          || replayedVersion?.versionNumber !== input.expectedPolicyVersion
        ) {
          throw new ConflictException(
            "Channel allocation run idempotency key was reused with different inputs",
          );
        }
        return replayed;
      }
      const [policy] = await tx.select().from(channelAllocationPolicies)
        .where(eq(channelAllocationPolicies.id, input.policyId)).limit(1);
      if (!policy) throw new NotFoundException("Channel allocation policy not found");
      if (policy.status !== "active") throw new ConflictException("Channel allocation policy is inactive");
      if (policy.currentVersion !== input.expectedPolicyVersion) {
        throw new ConflictException("Channel allocation policy version changed");
      }
      const [version] = await tx.select().from(channelAllocationPolicyVersions)
        .where(and(
          eq(channelAllocationPolicyVersions.policyId, policy.id),
          eq(channelAllocationPolicyVersions.versionNumber, policy.currentVersion),
        )).limit(1);
      if (!version) throw new ConflictException("Channel allocation policy version is missing");
      const [stockItem] = await tx.select().from(inventoryStockItems)
        .where(eq(inventoryStockItems.id, policy.stockItemId)).limit(1);
      if (!stockItem) throw new NotFoundException("Inventory stock item not found");
      const snapshots = await latestSnapshots(tx);
      const snapshotIds = snapshots.map((snapshot) => snapshot.id);
      const lines = snapshotIds.length
        ? await tx.select().from(networkInventorySnapshotLines).where(and(
          inArray(networkInventorySnapshotLines.snapshotId, snapshotIds),
          eq(networkInventorySnapshotLines.stockItemId, policy.stockItemId),
        ))
        : [];
      for (const line of lines) {
        if (line.unit !== stockItem.baseUnit) {
          throw new ConflictException("Network inventory unit does not match stock item base unit");
        }
      }
      const eligibleLines = lines.filter((line) =>
        line.condition === "sellable"
        && version.eligibleSources.includes(line.source)
        && (line.source !== "virtual" || version.allowVirtual));
      const eligibleQuantity = eligibleLines.reduce((total, line) => total + line.quantity, 0);
      const allocatableQuantity = Math.max(0, eligibleQuantity - version.safetyBufferQuantity);
      const trace = aggregateTrace(eligibleLines);
      let remaining = allocatableQuantity;
      const allocations = canonicalChannels(version.channels).map((channel) => {
        const gross = Math.min(remaining, channel.capQuantity ?? remaining);
        const allocatedQuantity = Math.max(0, gross - channel.bufferQuantity);
        remaining -= gross;
        return { channel, allocatedQuantity };
      });
      const allocatedQuantity = allocations.reduce((total, allocation) =>
        total + allocation.allocatedQuantity, 0);
      const inputChecksum = checksum({
        policyVersionChecksum: version.checksum,
        snapshots: snapshots.map((snapshot) => ({ id: snapshot.id, checksum: snapshot.checksum })),
        trace,
      });
      const [created] = await tx.insert(channelAllocationRuns).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        policyId: policy.id,
        policyVersionId: version.id,
        stockItemId: policy.stockItemId,
        eligibleQuantity,
        allocatableQuantity,
        allocatedQuantity,
        unit: stockItem.baseUnit,
        inputChecksum,
        idempotencyKey: input.idempotencyKey,
        calculatedBy: context.userId,
      }).returning();
      await tx.insert(channelAvailabilityProjections).values(allocations.map(({ channel, allocatedQuantity: quantity }) => ({
        id: createEntityId(),
        tenantId: context.tenantId,
        runId: created!.id,
        stockItemId: policy.stockItemId,
        accountId: channel.accountId,
        platform: channel.platform,
        marketplaceId: channel.marketplaceId,
        listingId: channel.listingId,
        priority: channel.priority,
        capQuantity: channel.capQuantity,
        bufferQuantity: channel.bufferQuantity,
        allocatedQuantity: quantity,
        unit: stockItem.baseUnit,
        sourceTrace: trace,
      })));
      return created!;
    });
    const view = await this.getRun(context, run.id);
    await this.audit.record(context, {
      action: "channel_inventory.allocation.run",
      resourceType: "channel_allocation_run",
      resourceId: view.id,
      result: "success",
      metadata: {
        policyId: view.policyId,
        policyVersion: view.policyVersion,
        eligibleQuantity: view.eligibleQuantity,
        allocatedQuantity: view.allocatedQuantity,
      },
    });
    return view;
  }

  async getRun(context: TenantContext, runId: string): Promise<ChannelAllocationRunView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [run] = await tx.select().from(channelAllocationRuns)
        .where(eq(channelAllocationRuns.id, runId)).limit(1);
      if (!run) throw new NotFoundException("Channel allocation run not found");
      return runView(tx, run);
    });
  }

  async recordReconciliation(
    context: TenantContext,
    rawInput: RecordChannelMutationReconciliationInput,
  ): Promise<ChannelMutationReconciliationView> {
    const input = RecordChannelMutationReconciliationInputSchema.parse(rawInput);
    const row = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `channel-reconciliation:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(channelMutationReconciliations)
        .where(eq(channelMutationReconciliations.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        const [opened] = await tx.select().from(channelMutationReconciliationEvents)
          .where(and(
            eq(channelMutationReconciliationEvents.reconciliationId, replayed.id),
            eq(channelMutationReconciliationEvents.sequence, 1),
          ))
          .limit(1);
        if (
          replayed.accountId !== input.accountId
          || replayed.listingId !== input.listingId
          || replayed.syncRequestId !== input.syncRequestId
          || replayed.mutationKey !== input.mutationKey
          || opened?.reasonCode !== input.reasonCode
          || opened?.message !== input.message
        ) {
          throw new ConflictException(
            "Channel mutation reconciliation idempotency key was reused with different evidence",
          );
        }
        return replayed;
      }
      const [account] = await tx.select().from(marketplaceAccounts)
        .where(eq(marketplaceAccounts.id, input.accountId)).limit(1);
      if (!account) throw new NotFoundException("Marketplace account not found");
      if (input.listingId) {
        const [listing] = await tx.select().from(listings)
          .where(eq(listings.id, input.listingId)).limit(1);
        if (!listing) throw new NotFoundException("Listing not found");
      }
      const [created] = await tx.insert(channelMutationReconciliations).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        accountId: input.accountId,
        listingId: input.listingId,
        syncRequestId: input.syncRequestId,
        mutationKey: input.mutationKey,
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      }).returning();
      await tx.insert(channelMutationReconciliationEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        reconciliationId: created!.id,
        sequence: 1,
        status: "open",
        reasonCode: input.reasonCode,
        message: input.message,
        idempotencyKey: input.idempotencyKey,
        actorUserId: context.userId,
      });
      return created!;
    });
    return this.getReconciliation(context, row.id);
  }

  async resolveReconciliation(
    context: TenantContext,
    reconciliationId: string,
    rawInput: ResolveChannelMutationReconciliationInput,
  ): Promise<ChannelMutationReconciliationView> {
    const input = ResolveChannelMutationReconciliationInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `channel-reconciliation:${context.tenantId}:${reconciliationId}`);
      const [row] = await tx.select().from(channelMutationReconciliations)
        .where(eq(channelMutationReconciliations.id, reconciliationId)).limit(1);
      if (!row) throw new NotFoundException("Channel mutation reconciliation not found");
      const events = await tx.select().from(channelMutationReconciliationEvents)
        .where(eq(channelMutationReconciliationEvents.reconciliationId, reconciliationId))
        .orderBy(desc(channelMutationReconciliationEvents.sequence));
      const latest = events[0];
      if (!latest) throw new ConflictException("Channel mutation reconciliation has no event history");
      const replayed = events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (replayed) {
        if (replayed.status !== input.outcome || replayed.reasonCode !== input.reasonCode) {
          throw new ConflictException(
            "Channel mutation reconciliation resolution idempotency key was reused with a different outcome",
          );
        }
        return;
      }
      if (latest.status !== "open") throw new ConflictException("Channel mutation reconciliation is already resolved");
      await tx.insert(channelMutationReconciliationEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        reconciliationId,
        sequence: latest.sequence + 1,
        status: input.outcome,
        reasonCode: input.reasonCode,
        message: `Reconciliation ${input.outcome}`,
        idempotencyKey: input.idempotencyKey,
        actorUserId: context.userId,
      });
    });
    return this.getReconciliation(context, reconciliationId);
  }

  async getReconciliation(
    context: TenantContext,
    reconciliationId: string,
  ): Promise<ChannelMutationReconciliationView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select().from(channelMutationReconciliations)
        .where(eq(channelMutationReconciliations.id, reconciliationId)).limit(1);
      if (!row) throw new NotFoundException("Channel mutation reconciliation not found");
      return reconciliationView(tx, row);
    });
  }

  async workspace(context: TenantContext): Promise<ChannelInventoryWorkspaceView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [stockItemRows, accountRows, snapshotRows, policyRows, runRows, reconciliationRows] = await Promise.all([
        tx.select().from(inventoryStockItems).orderBy(inventoryStockItems.name),
        tx.select().from(marketplaceAccounts).orderBy(marketplaceAccounts.displayName),
        tx.select().from(networkInventorySnapshots)
          .orderBy(desc(networkInventorySnapshots.recordedAt)).limit(20),
        tx.select().from(channelAllocationPolicies)
          .orderBy(desc(channelAllocationPolicies.updatedAt)).limit(100),
        tx.select().from(channelAllocationRuns)
          .orderBy(desc(channelAllocationRuns.calculatedAt)).limit(20),
        tx.select().from(channelMutationReconciliations)
          .orderBy(desc(channelMutationReconciliations.createdAt)).limit(100),
      ]);
      return ChannelInventoryWorkspaceViewSchema.parse({
        stockItems: stockItemRows.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          unit: row.baseUnit,
        })),
        accounts: accountRows.map((row) => ({
          id: row.id,
          displayName: row.displayName,
          platform: row.platform,
        })),
        snapshots: await Promise.all(snapshotRows.map((row) => snapshotView(tx, row))),
        policies: await Promise.all(policyRows.map((row) => policyView(tx, row))),
        runs: await Promise.all(runRows.map((row) => runView(tx, row))),
        reconciliations: await Promise.all(reconciliationRows.map((row) => reconciliationView(tx, row))),
      });
    });
  }

  async assertMarketplaceAllocations(
    tx: TenantTransaction,
    input: {
      accountId: string;
      platform: "amazon" | "etsy";
      marketplaceId: string;
      listingId: string;
      desired: Array<{ skuCode: string; quantity: number }>;
    },
  ): Promise<void> {
    for (const target of input.desired) {
      const [sku] = await tx.select().from(skus).where(eq(skus.code, target.skuCode)).limit(1);
      if (!sku) throw new ConflictException(`Listing SKU ${target.skuCode} is not linked to catalog inventory`);
      const [stockItem] = await tx.select().from(inventoryStockItems)
        .where(eq(inventoryStockItems.skuId, sku.id)).limit(1);
      if (!stockItem) throw new ConflictException(`Listing SKU ${target.skuCode} has no stock item`);
      const [policy] = await tx.select().from(channelAllocationPolicies)
        .where(and(
          eq(channelAllocationPolicies.stockItemId, stockItem.id),
          eq(channelAllocationPolicies.status, "active"),
        )).limit(1);
      if (!policy) throw new ConflictException(`Listing SKU ${target.skuCode} has no active channel allocation policy`);
      const [version] = await tx.select().from(channelAllocationPolicyVersions)
        .where(and(
          eq(channelAllocationPolicyVersions.policyId, policy.id),
          eq(channelAllocationPolicyVersions.versionNumber, policy.currentVersion),
        )).limit(1);
      if (!version) throw new ConflictException("Current channel allocation policy version is missing");
      const [run] = await tx.select().from(channelAllocationRuns)
        .where(and(
          eq(channelAllocationRuns.policyId, policy.id),
          eq(channelAllocationRuns.policyVersionId, version.id),
        )).orderBy(desc(channelAllocationRuns.calculatedAt)).limit(1);
      if (!run) throw new ConflictException(`Listing SKU ${target.skuCode} has no current channel allocation projection`);
      const [projection] = await tx.select().from(channelAvailabilityProjections)
        .where(and(
          eq(channelAvailabilityProjections.runId, run.id),
          eq(channelAvailabilityProjections.accountId, input.accountId),
          eq(channelAvailabilityProjections.platform, input.platform),
          eq(channelAvailabilityProjections.marketplaceId, input.marketplaceId),
          or(
            eq(channelAvailabilityProjections.listingId, input.listingId),
            isNull(channelAvailabilityProjections.listingId),
          ),
        ))
        .orderBy(desc(channelAvailabilityProjections.listingId))
        .limit(1);
      if (!projection) throw new ConflictException(`Listing SKU ${target.skuCode} has no allocation for this channel`);
      const [newerEvidence] = await tx.select({ id: networkInventorySnapshots.id })
        .from(networkInventorySnapshotLines)
        .innerJoin(
          networkInventorySnapshots,
          eq(networkInventorySnapshots.id, networkInventorySnapshotLines.snapshotId),
        )
        .where(and(
          eq(networkInventorySnapshotLines.stockItemId, stockItem.id),
          gt(networkInventorySnapshots.recordedAt, run.calculatedAt),
        ))
        .limit(1);
      if (newerEvidence) {
        throw new ConflictException(`Listing SKU ${target.skuCode} allocation is stale after newer inventory evidence`);
      }
      if (target.quantity > projection.allocatedQuantity) {
        throw new UnprocessableEntityException(
          `Listing SKU ${target.skuCode} quantity ${target.quantity} exceeds channel allocation ${projection.allocatedQuantity}`,
        );
      }
    }
  }
}

async function validateSnapshotReferences(
  tx: TenantTransaction,
  input: RecordNetworkInventorySnapshotInput,
) {
  if ((input.provider === "amazon" || input.provider === "etsy") && !input.accountId) {
    throw new ConflictException("Marketplace inventory snapshots require an account");
  }
  if (input.accountId) {
    const [account] = await tx.select().from(marketplaceAccounts)
      .where(eq(marketplaceAccounts.id, input.accountId)).limit(1);
    if (!account) throw new NotFoundException("Marketplace account not found");
    if ((input.provider === "amazon" || input.provider === "etsy") && account.platform !== input.provider) {
      throw new ConflictException("Inventory provider does not match marketplace account");
    }
  }
  for (const line of input.lines) {
    const [stockItem] = await tx.select().from(inventoryStockItems)
      .where(eq(inventoryStockItems.id, line.stockItemId)).limit(1);
    if (!stockItem) throw new NotFoundException("Inventory stock item not found");
    if (stockItem.baseUnit !== line.unit) throw new ConflictException("Inventory snapshot unit does not match stock item");
    let warehouseId: string | null = null;
    if (line.warehouseId) {
      const [warehouse] = await tx.select().from(inventoryWarehouses)
        .where(eq(inventoryWarehouses.id, line.warehouseId)).limit(1);
      if (!warehouse) throw new NotFoundException("Inventory warehouse not found");
      warehouseId = warehouse.id;
    }
    if (line.locationId) {
      const [location] = await tx.select().from(inventoryLocations)
        .where(eq(inventoryLocations.id, line.locationId)).limit(1);
      if (!location) throw new NotFoundException("Inventory location not found");
      if (warehouseId && location.warehouseId !== warehouseId) {
        throw new ConflictException("Inventory location does not belong to snapshot warehouse");
      }
    }
  }
}

async function validatePolicyReferences(
  tx: TenantTransaction,
  input: UpsertChannelAllocationPolicyInput,
) {
  const [stockItem] = await tx.select().from(inventoryStockItems)
    .where(eq(inventoryStockItems.id, input.stockItemId)).limit(1);
  if (!stockItem) throw new NotFoundException("Inventory stock item not found");
  const sku = stockItem.skuId
    ? (await tx.select().from(skus).where(eq(skus.id, stockItem.skuId)).limit(1))[0]
    : undefined;
  for (const channel of input.channels) {
    const [account] = await tx.select().from(marketplaceAccounts)
      .where(eq(marketplaceAccounts.id, channel.accountId)).limit(1);
    if (!account) throw new NotFoundException("Marketplace account not found");
    if (account.platform !== channel.platform) {
      throw new ConflictException("Channel platform does not match marketplace account");
    }
    if (!account.marketplaceIds.includes(channel.marketplaceId)) {
      throw new ConflictException("Channel marketplace is not configured on the account");
    }
    if (channel.listingId) {
      const [listing] = await tx.select().from(listings)
        .where(eq(listings.id, channel.listingId)).limit(1);
      if (!listing) throw new NotFoundException("Channel Listing not found");
      if (listing.platform !== channel.platform || listing.marketplaceId !== channel.marketplaceId) {
        throw new ConflictException("Channel Listing does not match allocation target");
      }
      if (sku && listing.spuId !== sku.spuId) {
        throw new ConflictException("Channel Listing does not contain the allocated stock item");
      }
    }
  }
}

async function latestSnapshots(tx: TenantTransaction): Promise<SnapshotRow[]> {
  const rows = await tx.select().from(networkInventorySnapshots)
    .orderBy(desc(networkInventorySnapshots.recordedAt));
  const latest = new Map<string, SnapshotRow>();
  for (const row of rows) {
    const key = `${row.provider}:${row.scopeKey}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()];
}

async function snapshotView(
  tx: TenantTransaction,
  snapshot: SnapshotRow,
): Promise<NetworkInventorySnapshotView> {
  const [lines, checkpoints] = await Promise.all([
    tx.select().from(networkInventorySnapshotLines)
      .where(eq(networkInventorySnapshotLines.snapshotId, snapshot.id))
      .orderBy(networkInventorySnapshotLines.lineNumber),
    tx.select().from(networkInventoryConnectorCheckpoints)
      .where(eq(networkInventoryConnectorCheckpoints.snapshotId, snapshot.id)).limit(1),
  ]);
  const checkpoint = checkpoints[0];
  if (!checkpoint) throw new ConflictException("Network inventory snapshot checkpoint is missing");
  return NetworkInventorySnapshotViewSchema.parse({
    id: snapshot.id,
    accountId: snapshot.accountId,
    provider: snapshot.provider,
    scopeKey: snapshot.scopeKey,
    providerSnapshotId: snapshot.providerSnapshotId,
    checkpointSequence: checkpoint.sequence,
    checkpointCursor: checkpoint.cursor,
    observedAt: snapshot.observedAt.toISOString(),
    recordedAt: snapshot.recordedAt.toISOString(),
    checksum: snapshot.checksum,
    lines: lines.map((line) => ({
      id: line.id,
      stockItemId: line.stockItemId,
      warehouseId: line.warehouseId,
      locationId: line.locationId,
      externalSku: line.externalSku,
      source: line.source,
      condition: line.condition,
      quantity: line.quantity,
      unit: line.unit,
    })),
  });
}

async function policyView(
  tx: TenantTransaction,
  policy: PolicyRow,
): Promise<ChannelAllocationPolicyView> {
  const [version] = await tx.select().from(channelAllocationPolicyVersions)
    .where(and(
      eq(channelAllocationPolicyVersions.policyId, policy.id),
      eq(channelAllocationPolicyVersions.versionNumber, policy.currentVersion),
    )).limit(1);
  if (!version) throw new ConflictException("Channel allocation policy version is missing");
  return ChannelAllocationPolicyViewSchema.parse({
    id: policy.id,
    stockItemId: policy.stockItemId,
    name: policy.name,
    currentVersion: policy.currentVersion,
    status: policy.status,
    version: {
      id: version.id,
      version: version.versionNumber,
      eligibleSources: version.eligibleSources,
      allowVirtual: version.allowVirtual,
      safetyBufferQuantity: version.safetyBufferQuantity,
      channels: version.channels,
      reasonCode: version.reasonCode,
      checksum: version.checksum,
      createdAt: version.createdAt.toISOString(),
    },
  });
}

async function runView(tx: TenantTransaction, run: RunRow): Promise<ChannelAllocationRunView> {
  const [[version], projections] = await Promise.all([
    tx.select().from(channelAllocationPolicyVersions)
      .where(eq(channelAllocationPolicyVersions.id, run.policyVersionId)).limit(1),
    tx.select().from(channelAvailabilityProjections)
      .where(eq(channelAvailabilityProjections.runId, run.id))
      .orderBy(channelAvailabilityProjections.priority),
  ]);
  if (!version) throw new ConflictException("Channel allocation run policy version is missing");
  return ChannelAllocationRunViewSchema.parse({
    id: run.id,
    policyId: run.policyId,
    policyVersionId: run.policyVersionId,
    policyVersion: version.versionNumber,
    stockItemId: run.stockItemId,
    eligibleQuantity: run.eligibleQuantity,
    allocatableQuantity: run.allocatableQuantity,
    allocatedQuantity: run.allocatedQuantity,
    unit: run.unit,
    inputChecksum: run.inputChecksum,
    calculatedAt: run.calculatedAt.toISOString(),
    projections: projections.map((projection) => ({
      id: projection.id,
      runId: projection.runId,
      stockItemId: projection.stockItemId,
      accountId: projection.accountId,
      platform: projection.platform,
      marketplaceId: projection.marketplaceId,
      listingId: projection.listingId,
      priority: projection.priority,
      capQuantity: projection.capQuantity,
      bufferQuantity: projection.bufferQuantity,
      allocatedQuantity: projection.allocatedQuantity,
      unit: projection.unit,
      sourceTrace: projection.sourceTrace,
      calculatedAt: projection.calculatedAt.toISOString(),
    })),
  });
}

async function reconciliationView(
  tx: TenantTransaction,
  row: ReconciliationRow,
): Promise<ChannelMutationReconciliationView> {
  const [latest] = await tx.select().from(channelMutationReconciliationEvents)
    .where(eq(channelMutationReconciliationEvents.reconciliationId, row.id))
    .orderBy(desc(channelMutationReconciliationEvents.sequence)).limit(1);
  if (!latest) throw new ConflictException("Channel mutation reconciliation has no event history");
  return ChannelMutationReconciliationViewSchema.parse({
    id: row.id,
    accountId: row.accountId,
    listingId: row.listingId,
    syncRequestId: row.syncRequestId,
    mutationKey: row.mutationKey,
    status: latest.status,
    reasonCode: latest.reasonCode,
    message: latest.message,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: latest.status === "open" ? null : latest.occurredAt.toISOString(),
  });
}

function aggregateTrace(lines: Array<typeof networkInventorySnapshotLines.$inferSelect>) {
  const grouped = new Map<string, {
    snapshotId: string;
    source: typeof lines[number]["source"];
    condition: typeof lines[number]["condition"];
    quantity: number;
  }>();
  for (const line of lines) {
    const key = `${line.snapshotId}:${line.source}:${line.condition}`;
    const current = grouped.get(key);
    if (current) current.quantity += line.quantity;
    else grouped.set(key, {
      snapshotId: line.snapshotId,
      source: line.source,
      condition: line.condition,
      quantity: line.quantity,
    });
  }
  return [...grouped.values()].sort((left, right) =>
    `${left.snapshotId}:${left.source}:${left.condition}`
      .localeCompare(`${right.snapshotId}:${right.source}:${right.condition}`));
}

function canonicalChannels(
  channels: UpsertChannelAllocationPolicyInput["channels"],
): UpsertChannelAllocationPolicyInput["channels"] {
  return [...channels].sort((left, right) =>
    left.priority - right.priority
    || left.accountId.localeCompare(right.accountId)
    || left.marketplaceId.localeCompare(right.marketplaceId)
    || (left.listingId ?? "").localeCompare(right.listingId ?? ""));
}

async function lock(tx: TenantTransaction, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

function checksum(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
