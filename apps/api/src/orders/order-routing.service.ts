import { createHash } from "node:crypto";

import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  CreateFulfillmentSupplierInputSchema, CreateRoutingPolicyInputSchema,
  CreateSupplierCapacityWindowInputSchema, CreateSupplierCapabilitySnapshotInputSchema,
  CreateSupplierQuoteInputSchema, ManualRoutingOverrideInputSchema, ReviewRoutingDecisionInputSchema,
  RouteOrderLineInputSchema, createEntityId,
  type CreateFulfillmentSupplierInput, type CreateRoutingPolicyInput,
  type CreateSupplierCapacityWindowInput, type CreateSupplierCapabilitySnapshotInput,
  type CreateSupplierQuoteInput, type ManualRoutingOverrideInput, type ReviewRoutingDecisionInput,
  type RouteOrderLineInput, type TenantContext,
} from "@yummyai/contracts";
import {
  fulfillmentSuppliers, orderLineCatalogLinks, orderLines, orderRoutingDecisionEvents,
  orderRoutingDecisions, orders, productionOrderCandidates, purchaseOrders, purchaseOrderVersions,
  routingPolicyVersions, supplierCapacityWindows, supplierCapabilitySnapshots, supplierQuotes,
  type DatabaseConnection, type TenantTransaction, withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { evaluateSupplierRouting, type RoutingSourceCandidate } from "./order-routing-engine.js";
import { OrderService } from "./order.service.js";

@Injectable()
export class OrderRoutingService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(OrderService) private readonly orderService: OrderService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createSupplier(context: TenantContext, rawInput: CreateFulfillmentSupplierInput) {
    const input = CreateFulfillmentSupplierInputSchema.parse(rawInput);
    const [supplier] = await withTenant(this.database.db, context, (tx) => tx.insert(fulfillmentSuppliers).values({
      id: createEntityId(), tenantId: context.tenantId, ...input, priority: 3, createdBy: context.userId,
    }).returning());
    await this.audit.record(context, { action: "supplier.create", resourceType: "fulfillment_supplier", resourceId: supplier!.id, result: "success", metadata: { kind: supplier!.kind } });
    return supplier!;
  }

  listSuppliers(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) => tx.select().from(fulfillmentSuppliers)
      .orderBy(asc(fulfillmentSuppliers.priority), asc(fulfillmentSuppliers.name)));
  }

  async addCapability(context: TenantContext, rawInput: CreateSupplierCapabilitySnapshotInput) {
    const input = CreateSupplierCapabilitySnapshotInputSchema.parse(rawInput);
    return withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `supplier-capability:${input.supplierId}`);
      await requireSupplier(tx, input.supplierId);
      const [latest] = await tx.select({ version: supplierCapabilitySnapshots.versionNumber }).from(supplierCapabilitySnapshots)
        .where(eq(supplierCapabilitySnapshots.supplierId, input.supplierId)).orderBy(desc(supplierCapabilitySnapshots.versionNumber)).limit(1);
      const [row] = await tx.insert(supplierCapabilitySnapshots).values({
        id: createEntityId(), tenantId: context.tenantId, ...input, effectiveAt: new Date(input.effectiveAt), versionNumber: (latest?.version ?? 0) + 1,
      }).returning();
      return row!;
    });
  }

  async addQuote(context: TenantContext, rawInput: CreateSupplierQuoteInput) {
    const input = CreateSupplierQuoteInputSchema.parse(rawInput);
    return withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `supplier-quote:${input.supplierId}:${input.skuId}`);
      await requireSupplier(tx, input.supplierId);
      const [latest] = await tx.select({ version: supplierQuotes.versionNumber }).from(supplierQuotes)
        .where(and(eq(supplierQuotes.supplierId, input.supplierId), eq(supplierQuotes.skuId, input.skuId)))
        .orderBy(desc(supplierQuotes.versionNumber)).limit(1);
      const [row] = await tx.insert(supplierQuotes).values({
        id: createEntityId(), tenantId: context.tenantId, ...input, validFrom: new Date(input.validFrom), validUntil: new Date(input.validUntil), versionNumber: (latest?.version ?? 0) + 1,
      }).returning();
      return row!;
    });
  }

  async addCapacity(context: TenantContext, rawInput: CreateSupplierCapacityWindowInput) {
    const input = CreateSupplierCapacityWindowInputSchema.parse(rawInput);
    const windowKey = `${input.startsAt}/${input.endsAt}`;
    return withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `supplier-capacity:${input.supplierId}:${windowKey}`);
      await requireSupplier(tx, input.supplierId);
      const [latest] = await tx.select({ version: supplierCapacityWindows.versionNumber }).from(supplierCapacityWindows)
        .where(and(eq(supplierCapacityWindows.supplierId, input.supplierId), eq(supplierCapacityWindows.windowKey, windowKey)))
        .orderBy(desc(supplierCapacityWindows.versionNumber)).limit(1);
      const [row] = await tx.insert(supplierCapacityWindows).values({
        id: createEntityId(), tenantId: context.tenantId, ...input, windowKey,
        startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), versionNumber: (latest?.version ?? 0) + 1,
      }).returning();
      return row!;
    });
  }

  async createPolicy(context: TenantContext, rawInput: CreateRoutingPolicyInput) {
    const input = CreateRoutingPolicyInputSchema.parse(rawInput);
    return withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `routing-policy:${input.name}`);
      const [latest] = await tx.select({ version: routingPolicyVersions.versionNumber }).from(routingPolicyVersions)
        .where(eq(routingPolicyVersions.name, input.name)).orderBy(desc(routingPolicyVersions.versionNumber)).limit(1);
      const [row] = await tx.insert(routingPolicyVersions).values({
        id: createEntityId(), tenantId: context.tenantId, name: input.name, versionNumber: (latest?.version ?? 0) + 1,
        weights: input.weights, thresholds: {
          minimumQualityBps: input.minimumQualityBps, maximumLeadTimeDays: input.maximumLeadTimeDays,
          maximumUnitCostMinor: input.maximumUnitCostMinor, manualApprovalCostMinor: input.manualApprovalCostMinor,
          manualApprovalRiskBps: input.manualApprovalRiskBps,
        }, tieBreaker: input.tieBreaker, active: true, createdBy: context.userId,
      }).returning();
      return row!;
    });
  }

  async route(context: TenantContext, orderId: string, rawInput: RouteOrderLineInput) {
    const input = RouteOrderLineInputSchema.parse(rawInput);
    const evaluatedAt = new Date();
    let noEligible = false;
    const decisionId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `routing-line:${input.orderLineId}`);
      const [replayed] = await tx.select({ id: orderRoutingDecisions.id }).from(orderRoutingDecisions).where(and(
        eq(orderRoutingDecisions.orderLineId, input.orderLineId), eq(orderRoutingDecisions.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return replayed.id;
      const [line] = await tx.select({ line: orderLines, order: orders, skuId: orderLineCatalogLinks.skuId })
        .from(orderLines).innerJoin(orders, eq(orders.id, orderLines.orderId))
        .leftJoin(orderLineCatalogLinks, eq(orderLineCatalogLinks.orderLineId, orderLines.id))
        .where(and(eq(orderLines.id, input.orderLineId), eq(orderLines.orderId, orderId))).limit(1);
      if (!line) throw new NotFoundException("Order line not found");
      if (line.order.workflowState !== "awaiting_routing") throw new ConflictException("Order must be awaiting routing");
      if (!line.skuId) throw new ConflictException("Order line requires a pinned SKU before routing");
      const [policy] = await tx.select().from(routingPolicyVersions).where(eq(routingPolicyVersions.id, input.routingPolicyId)).limit(1);
      if (!policy) throw new NotFoundException("Routing policy version not found");
      const suppliers = await tx.select().from(fulfillmentSuppliers);
      const capabilities = await tx.select().from(supplierCapabilitySnapshots).where(lte(supplierCapabilitySnapshots.effectiveAt, evaluatedAt)).orderBy(desc(supplierCapabilitySnapshots.versionNumber));
      const quotes = await tx.select().from(supplierQuotes).where(eq(supplierQuotes.skuId, line.skuId)).orderBy(desc(supplierQuotes.versionNumber));
      const capacities = await tx.select().from(supplierCapacityWindows).orderBy(desc(supplierCapacityWindows.versionNumber));
      const sourceCandidates: RoutingSourceCandidate[] = [];
      for (const supplier of suppliers) {
        const capability = capabilities.find((entry) => entry.supplierId === supplier.id);
        const quote = quotes.find((entry) => entry.supplierId === supplier.id);
        const capacity = capacities.find((entry) => entry.supplierId === supplier.id);
        if (!capability || !quote || !capacity) continue;
        sourceCandidates.push({
          supplier: { id: supplier.id, status: supplier.status as "active" | "suspended" | "archived", priority: supplier.priority },
          capability: {
            id: capability.id, supportedSkuIds: capability.supportedSkuIds, processCodes: capability.processCodes,
            serviceCountryCodes: capability.serviceCountryCodes, blockedRegionCodes: capability.blockedRegionCodes,
            qualityScoreBps: capability.qualityScoreBps,
          },
          quote: { ...quote, validFrom: quote.validFrom.toISOString(), validUntil: quote.validUntil.toISOString() },
          capacity: { ...capacity, startsAt: capacity.startsAt.toISOString(), endsAt: capacity.endsAt.toISOString() },
        });
      }
      const thresholds = policy.thresholds;
      const result = evaluateSupplierRouting({
        skuId: line.skuId, quantity: line.line.quantity, currency: line.line.unitPriceCurrency,
        processCodes: input.processCodes, destinationCountryCode: input.destinationCountryCode,
        destinationRegionCode: input.destinationRegionCode, evaluatedAt: evaluatedAt.toISOString(),
        policy: { id: policy.id, versionNumber: policy.versionNumber, name: policy.name, weights: policy.weights,
          minimumQualityBps: thresholds.minimumQualityBps, maximumLeadTimeDays: thresholds.maximumLeadTimeDays,
          maximumUnitCostMinor: thresholds.maximumUnitCostMinor, manualApprovalCostMinor: thresholds.manualApprovalCostMinor,
          manualApprovalRiskBps: thresholds.manualApprovalRiskBps,
          tieBreaker: policy.tieBreaker as ["total_score", "unit_cost", "lead_time", "supplier_id"] },
        candidates: sourceCandidates,
      });
      const [latest] = await tx.select({ version: orderRoutingDecisions.versionNumber }).from(orderRoutingDecisions)
        .where(eq(orderRoutingDecisions.orderLineId, input.orderLineId)).orderBy(desc(orderRoutingDecisions.versionNumber)).limit(1);
      const id = createEntityId();
      const status = !result.selectedSupplierId ? "no_eligible_supplier" : result.requiresApproval ? "pending_approval" : "approved";
      noEligible = status === "no_eligible_supplier";
      await tx.insert(orderRoutingDecisions).values({
        id, tenantId: context.tenantId, orderId, orderLineId: input.orderLineId, routingPolicyVersionId: policy.id,
        versionNumber: (latest?.version ?? 0) + 1, status, selectedSupplierId: result.selectedSupplierId,
        inputChecksum: result.inputChecksum, requiresApproval: result.requiresApproval, approvalReasons: result.approvalReasons,
        idempotencyKey: input.idempotencyKey,
      });
      if (result.candidates.length) await tx.insert(productionOrderCandidates).values(result.candidates.map((candidate, index) => ({
        id: createEntityId(), tenantId: context.tenantId, routingDecisionId: id, rank: index + 1, ...candidate,
      })));
      await tx.insert(orderRoutingDecisionEvents).values({
        id: createEntityId(), tenantId: context.tenantId, routingDecisionId: id, sequence: 1, type: "evaluated",
        supplierId: result.selectedSupplierId, actorUserId: context.userId,
      });
      return id;
    });
    if (noEligible) await this.orderService.openException(context, orderId, {
      category: "sourcing", code: "NO_ELIGIBLE_SUPPLIER", message: "No eligible supplier matched the pinned routing inputs.",
      idempotencyKey: `routing-no-supplier:${decisionId}`,
    });
    const decision = await this.get(context, decisionId);
    if (decision.decision.status === "approved") await this.synchronizePurchaseOrders(context, orderId);
    await this.audit.record(context, { action: "order.routing.evaluate", resourceType: "order_routing_decision", resourceId: decisionId, result: "success", metadata: { orderId, status: decision.decision.status } });
    return this.get(context, decisionId);
  }

  async override(context: TenantContext, decisionId: string, rawInput: ManualRoutingOverrideInput) {
    const input = ManualRoutingOverrideInputSchema.parse(rawInput);
    const orderId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `routing-decision:${decisionId}`);
      const [decision] = await tx.select().from(orderRoutingDecisions).where(eq(orderRoutingDecisions.id, decisionId)).limit(1);
      if (!decision) throw new NotFoundException("Routing decision not found");
      if (decision.decisionVersion !== input.expectedDecisionVersion) throw new ConflictException("Routing decision version changed");
      const [candidate] = await tx.select().from(productionOrderCandidates).where(and(
        eq(productionOrderCandidates.routingDecisionId, decisionId), eq(productionOrderCandidates.supplierId, input.supplierId),
      )).limit(1);
      if (!candidate?.eligible) throw new UnprocessableEntityException("Manual override must select an eligible recorded candidate");
      const [latestEvent] = await tx.select({ sequence: orderRoutingDecisionEvents.sequence }).from(orderRoutingDecisionEvents)
        .where(eq(orderRoutingDecisionEvents.routingDecisionId, decisionId)).orderBy(desc(orderRoutingDecisionEvents.sequence)).limit(1);
      await tx.update(orderRoutingDecisions).set({
        selectedSupplierId: input.supplierId, status: "pending_approval", requiresApproval: true,
        approvalReasons: [...new Set([...decision.approvalReasons, "manual_override"])],
        decisionVersion: decision.decisionVersion + 1, updatedAt: new Date(),
      }).where(and(eq(orderRoutingDecisions.id, decisionId), eq(orderRoutingDecisions.decisionVersion, input.expectedDecisionVersion)));
      await tx.insert(orderRoutingDecisionEvents).values({
        id: createEntityId(), tenantId: context.tenantId, routingDecisionId: decisionId,
        sequence: (latestEvent?.sequence ?? 0) + 1, type: "overridden", supplierId: input.supplierId,
        reasonCode: input.reasonCode, reason: input.reason, actorUserId: context.userId,
      });
      return decision.orderId;
    });
    await this.audit.record(context, { action: "order.routing.override", resourceType: "order_routing_decision", resourceId: decisionId, result: "success", metadata: { orderId, reasonCode: input.reasonCode } });
    return this.get(context, decisionId);
  }

  async review(context: TenantContext, decisionId: string, rawInput: ReviewRoutingDecisionInput) {
    const input = ReviewRoutingDecisionInputSchema.parse(rawInput);
    const orderId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `routing-decision:${decisionId}`);
      const [decision] = await tx.select().from(orderRoutingDecisions).where(eq(orderRoutingDecisions.id, decisionId)).limit(1);
      if (!decision) throw new NotFoundException("Routing decision not found");
      if (decision.decisionVersion !== input.expectedDecisionVersion) throw new ConflictException("Routing decision version changed");
      if (decision.status !== "pending_approval") throw new ConflictException("Only pending routing decisions can be reviewed");
      const [latestEvent] = await tx.select({ sequence: orderRoutingDecisionEvents.sequence }).from(orderRoutingDecisionEvents)
        .where(eq(orderRoutingDecisionEvents.routingDecisionId, decisionId)).orderBy(desc(orderRoutingDecisionEvents.sequence)).limit(1);
      await tx.update(orderRoutingDecisions).set({ status: input.action === "approve" ? "approved" : "rejected", decisionVersion: decision.decisionVersion + 1, updatedAt: new Date() })
        .where(and(eq(orderRoutingDecisions.id, decisionId), eq(orderRoutingDecisions.decisionVersion, input.expectedDecisionVersion)));
      await tx.insert(orderRoutingDecisionEvents).values({
        id: createEntityId(), tenantId: context.tenantId, routingDecisionId: decisionId,
        sequence: (latestEvent?.sequence ?? 0) + 1, type: input.action === "approve" ? "approved" : "rejected",
        supplierId: decision.selectedSupplierId, reason: input.reason, actorUserId: context.userId,
      });
      return decision.orderId;
    });
    if (input.action === "approve") await this.synchronizePurchaseOrders(context, orderId);
    await this.audit.record(context, { action: `order.routing.${input.action}`, resourceType: "order_routing_decision", resourceId: decisionId, result: "success", metadata: { orderId } });
    return this.get(context, decisionId);
  }

  async get(context: TenantContext, decisionId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [decision] = await tx.select().from(orderRoutingDecisions).where(eq(orderRoutingDecisions.id, decisionId)).limit(1);
      if (!decision) throw new NotFoundException("Routing decision not found");
      const candidates = await tx.select().from(productionOrderCandidates).where(eq(productionOrderCandidates.routingDecisionId, decisionId)).orderBy(asc(productionOrderCandidates.rank));
      const events = await tx.select().from(orderRoutingDecisionEvents).where(eq(orderRoutingDecisionEvents.routingDecisionId, decisionId)).orderBy(asc(orderRoutingDecisionEvents.sequence));
      return { decision, candidates, events };
    });
  }

  list(context: TenantContext, orderId?: string) {
    return withTenant(this.database.db, context, (tx) => tx.select().from(orderRoutingDecisions)
      .where(orderId ? eq(orderRoutingDecisions.orderId, orderId) : undefined)
      .orderBy(desc(orderRoutingDecisions.selectedAt)));
  }

  private async synchronizePurchaseOrders(context: TenantContext, orderId: string) {
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `purchase-orders:${orderId}`);
      const allDecisions = await tx.select().from(orderRoutingDecisions).where(eq(orderRoutingDecisions.orderId, orderId))
        .orderBy(desc(orderRoutingDecisions.versionNumber));
      const latest = new Map<string, typeof orderRoutingDecisions.$inferSelect>();
      for (const decision of allDecisions) if (!latest.has(decision.orderLineId)) latest.set(decision.orderLineId, decision);
      const approved = [...latest.values()].filter((decision) => decision.status === "approved" && decision.selectedSupplierId);
      if (!approved.length) return;
      const candidates = await tx.select().from(productionOrderCandidates).where(inArray(productionOrderCandidates.routingDecisionId, approved.map((entry) => entry.id)));
      const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId));
      const order = (await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0]!;
      const bySupplier = new Map<string, typeof approved>();
      for (const decision of approved) bySupplier.set(decision.selectedSupplierId!, [...(bySupplier.get(decision.selectedSupplierId!) ?? []), decision]);
      for (const [supplierId, decisions] of bySupplier) {
        const snapshot = decisions.map((decision) => {
          const line = lines.find((entry) => entry.id === decision.orderLineId)!;
          const candidate = candidates.find((entry) => entry.routingDecisionId === decision.id && entry.supplierId === supplierId)!;
          return { orderLineId: line.id, quantity: line.quantity, unitCostMinor: candidate.unitCostMinor };
        }).sort((left, right) => left.orderLineId.localeCompare(right.orderLineId));
        const routingDecisionIds = decisions.map((entry) => entry.id).sort();
        const payload = { currency: order.orderCurrency, lineSnapshot: snapshot, routingDecisionIds };
        const digest = checksum(payload);
        let [purchaseOrder] = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.orderId, orderId), eq(purchaseOrders.supplierId, supplierId))).limit(1);
        if (!purchaseOrder) {
          [purchaseOrder] = await tx.insert(purchaseOrders).values({ id: createEntityId(), tenantId: context.tenantId, supplierId, orderId, status: "approved", currentVersionNumber: 1, createdBy: context.userId }).returning();
        }
        const [current] = await tx.select().from(purchaseOrderVersions).where(and(eq(purchaseOrderVersions.purchaseOrderId, purchaseOrder.id), eq(purchaseOrderVersions.versionNumber, purchaseOrder.currentVersionNumber))).limit(1);
        if (current?.checksum === digest) continue;
        const versionNumber = current ? purchaseOrder.currentVersionNumber + 1 : 1;
        await tx.insert(purchaseOrderVersions).values({
          id: createEntityId(), tenantId: context.tenantId, purchaseOrderId: purchaseOrder.id, versionNumber,
          currency: order.orderCurrency, totalMinor: snapshot.reduce((total, line) => total + line.quantity * line.unitCostMinor, 0),
          lineSnapshot: snapshot, routingDecisionIds, checksum: digest, createdBy: context.userId,
        });
        if (purchaseOrder.currentVersionNumber !== versionNumber || purchaseOrder.status !== "approved") await tx.update(purchaseOrders)
          .set({ currentVersionNumber: versionNumber, status: "approved", updatedAt: new Date() }).where(eq(purchaseOrders.id, purchaseOrder.id));
      }
    });
  }
}

async function requireSupplier(tx: TenantTransaction, supplierId: string) {
  const [supplier] = await tx.select({ id: fulfillmentSuppliers.id }).from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, supplierId)).limit(1);
  if (!supplier) throw new NotFoundException("Fulfillment supplier not found");
}

async function lock(tx: TenantTransaction, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

function checksum(value: unknown) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
