import { createHash } from "node:crypto";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  CalculateSupplierScorecardInputSchema,
  SupplierKpiDefinitionViewSchema,
  SupplierPerformanceWorkspaceViewSchema,
  SupplierScorecardRunViewSchema,
  UpsertSupplierKpiDefinitionInputSchema,
  type CalculateSupplierScorecardInput,
  type SupplierKpiDefinitionView,
  type SupplierKpiEvidenceReference,
  type SupplierKpiMetric,
  type SupplierKpiMetricDefinition,
  type SupplierKpiRawUnit,
  type SupplierPerformanceWorkspaceView,
  type SupplierScorecardDiagnosticView,
  type SupplierScorecardRunView,
  type UpsertSupplierKpiDefinitionInput,
} from "@yummyai/contracts/supplier-performance";
import {
  fulfillmentSuppliers,
  inventoryProcurementReceipts,
  inventoryProcurementRfqs,
  inventoryPurchaseOrderEvents,
  inventoryPurchaseOrders,
  inventoryPurchaseOrderVersions,
  inventorySupplierInvoices,
  inventorySupplierQuoteVersions,
  productionMilestoneEvents,
  productionOrders,
  productionOrderVersions,
  qualityInspections,
  supplierCapacityWindows,
  supplierKpiDefinitions,
  supplierKpiDefinitionVersions,
  supplierScorecardMetrics,
  supplierScorecardRuns,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

type DefinitionRow = typeof supplierKpiDefinitions.$inferSelect;
type DefinitionVersionRow = typeof supplierKpiDefinitionVersions.$inferSelect;
type RunRow = typeof supplierScorecardRuns.$inferSelect;

interface DerivedMetric {
  metric: SupplierKpiMetric;
  scoreBps: number | null;
  sampleCount: number;
  rawNumerator: number;
  rawDenominator: number;
  rawUnit: SupplierKpiRawUnit;
  evidenceReferences: SupplierKpiEvidenceReference[];
}

@Injectable()
export class SupplierPerformanceService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async upsertDefinition(
    context: TenantContext,
    rawInput: UpsertSupplierKpiDefinitionInput,
  ): Promise<SupplierKpiDefinitionView> {
    const input = UpsertSupplierKpiDefinitionInputSchema.parse(rawInput);
    const metrics = [...input.metrics].sort((left, right) => left.metric.localeCompare(right.metric));
    const versionChecksum = checksum({
      missingDataPolicy: input.missingDataPolicy,
      metrics,
      reasonCode: input.reasonCode,
    });

    const definition = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `supplier-kpi-definition:${input.definitionId ?? input.name}`);
      const [replayed] = await tx.select().from(supplierKpiDefinitionVersions)
        .where(eq(supplierKpiDefinitionVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.checksum !== versionChecksum) {
          throw new ConflictException("Supplier KPI definition idempotency key was reused");
        }
        const [parent] = await tx.select().from(supplierKpiDefinitions)
          .where(eq(supplierKpiDefinitions.id, replayed.definitionId)).limit(1);
        if (!parent) throw new NotFoundException("Supplier KPI definition not found");
        return parent;
      }

      let definitionRow: DefinitionRow | undefined;
      if (input.definitionId) {
        [definitionRow] = await tx.select().from(supplierKpiDefinitions)
          .where(eq(supplierKpiDefinitions.id, input.definitionId)).limit(1);
        if (!definitionRow) throw new NotFoundException("Supplier KPI definition not found");
        if (definitionRow.name !== input.name) {
          throw new UnprocessableEntityException("Definition name is immutable");
        }
      } else {
        [definitionRow] = await tx.select().from(supplierKpiDefinitions)
          .where(eq(supplierKpiDefinitions.name, input.name)).limit(1);
        if (definitionRow) throw new ConflictException("Supplier KPI definition name already exists");
        [definitionRow] = await tx.insert(supplierKpiDefinitions).values({
          id: createEntityId(),
          tenantId: context.tenantId,
          name: input.name,
          currentVersion: 1,
          status: "active",
          createdBy: context.userId,
        }).returning();
      }

      const versionNumber = input.definitionId ? definitionRow!.currentVersion + 1 : 1;
      await tx.insert(supplierKpiDefinitionVersions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        definitionId: definitionRow!.id,
        versionNumber,
        missingDataPolicy: input.missingDataPolicy,
        metrics,
        reasonCode: input.reasonCode,
        checksum: versionChecksum,
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      });
      if (definitionRow!.currentVersion !== versionNumber) {
        [definitionRow] = await tx.update(supplierKpiDefinitions).set({
          currentVersion: versionNumber,
          updatedAt: new Date(),
        }).where(eq(supplierKpiDefinitions.id, definitionRow!.id)).returning();
      }
      return definitionRow!;
    });

    const view = await withTenant(this.database.db, context, (tx) => definitionView(tx, definition));
    await this.audit.record(context, {
      action: "supplier_performance.definition.version",
      resourceType: "supplier_kpi_definition",
      resourceId: definition.id,
      result: "success",
      metadata: { version: view.currentVersion, missingDataPolicy: view.version.missingDataPolicy },
    });
    return view;
  }

  async calculateScorecard(
    context: TenantContext,
    rawInput: CalculateSupplierScorecardInput,
  ): Promise<SupplierScorecardRunView> {
    const input = CalculateSupplierScorecardInputSchema.parse(rawInput);
    const run = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `supplier-scorecard:${context.tenantId}:${input.idempotencyKey}`);
      const [definition] = await tx.select().from(supplierKpiDefinitions)
        .where(eq(supplierKpiDefinitions.id, input.definitionId)).limit(1);
      if (!definition) throw new NotFoundException("Supplier KPI definition not found");
      if (definition.currentVersion !== input.expectedDefinitionVersion) {
        throw new ConflictException("Supplier KPI definition version changed");
      }
      const [version] = await tx.select().from(supplierKpiDefinitionVersions).where(and(
        eq(supplierKpiDefinitionVersions.definitionId, definition.id),
        eq(supplierKpiDefinitionVersions.versionNumber, input.expectedDefinitionVersion),
      )).limit(1);
      if (!version) throw new NotFoundException("Supplier KPI definition version not found");
      const [supplier] = await tx.select().from(fulfillmentSuppliers)
        .where(eq(fulfillmentSuppliers.id, input.supplierId)).limit(1);
      if (!supplier) throw new NotFoundException("Supplier not found");

      const derived = await deriveSupplierMetrics(tx, input, version.metrics);
      const inputChecksum = checksum({
        definitionVersionId: version.id,
        definitionVersionChecksum: version.checksum,
        supplierId: input.supplierId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        evidenceCutoffAt: input.evidenceCutoffAt,
        metrics: derived.map((metric) => ({
          ...metric,
          evidenceReferences: [...metric.evidenceReferences].sort(compareEvidence),
        })),
      });
      const [replayed] = await tx.select().from(supplierScorecardRuns)
        .where(eq(supplierScorecardRuns.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.inputChecksum !== inputChecksum) {
          throw new ConflictException("Supplier scorecard idempotency key was reused");
        }
        return replayed;
      }

      const diagnostics = buildDiagnostics(derived, version.metrics);
      const overallScoreBps = calculateOverall(
        derived,
        version.metrics,
        version.missingDataPolicy,
      );
      const status = overallScoreBps === null ? "incomplete" : "complete";
      const runId = createEntityId();
      const [created] = await tx.insert(supplierScorecardRuns).values({
        id: runId,
        tenantId: context.tenantId,
        supplierId: input.supplierId,
        definitionId: definition.id,
        definitionVersionId: version.id,
        definitionVersion: version.versionNumber,
        status,
        overallScoreBps,
        windowStart: new Date(input.windowStart),
        windowEnd: new Date(input.windowEnd),
        evidenceCutoffAt: new Date(input.evidenceCutoffAt),
        diagnostics,
        inputChecksum,
        idempotencyKey: input.idempotencyKey,
        calculatedBy: context.userId,
      }).returning();
      await tx.insert(supplierScorecardMetrics).values(derived.map((metric) => ({
        id: createEntityId(),
        tenantId: context.tenantId,
        runId,
        metric: metric.metric,
        scoreBps: metric.scoreBps,
        sampleCount: metric.sampleCount,
        rawNumerator: metric.rawNumerator,
        rawDenominator: metric.rawDenominator,
        rawUnit: metric.rawUnit,
        evidenceReferences: metric.evidenceReferences,
      })));
      return created!;
    });

    const view = await withTenant(this.database.db, context, (tx) => scorecardView(tx, run));
    await this.audit.record(context, {
      action: "supplier_performance.scorecard.calculate",
      resourceType: "supplier_scorecard_run",
      resourceId: view.id,
      result: "success",
      metadata: {
        supplierId: view.supplierId,
        status: view.status,
        definitionVersion: view.definitionVersion,
        missingMetrics: view.diagnostics.missingMetrics.length,
      },
    });
    return view;
  }

  async getScorecard(context: TenantContext, runId: string): Promise<SupplierScorecardRunView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [run] = await tx.select().from(supplierScorecardRuns)
        .where(eq(supplierScorecardRuns.id, runId)).limit(1);
      if (!run) throw new NotFoundException("Supplier scorecard not found");
      return scorecardView(tx, run);
    });
  }

  async workspace(context: TenantContext): Promise<SupplierPerformanceWorkspaceView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [suppliers, definitions, runs] = await Promise.all([
        tx.select().from(fulfillmentSuppliers).orderBy(asc(fulfillmentSuppliers.name)).limit(250),
        tx.select().from(supplierKpiDefinitions).orderBy(asc(supplierKpiDefinitions.name)).limit(100),
        tx.select().from(supplierScorecardRuns).orderBy(desc(supplierScorecardRuns.calculatedAt)).limit(250),
      ]);
      return SupplierPerformanceWorkspaceViewSchema.parse({
        suppliers: suppliers.map((supplier) => ({
          id: supplier.id,
          name: supplier.name,
          kind: supplier.kind,
          status: supplier.status,
          regionCode: supplier.regionCode,
        })),
        definitions: await Promise.all(definitions.map((definition) => definitionView(tx, definition))),
        scorecards: await Promise.all(runs.map((run) => scorecardView(tx, run))),
      });
    });
  }
}

async function deriveSupplierMetrics(
  tx: TenantTransaction,
  input: CalculateSupplierScorecardInput,
  definitions: SupplierKpiMetricDefinition[],
): Promise<DerivedMetric[]> {
  const start = new Date(input.windowStart);
  const end = new Date(input.windowEnd);
  const cutoff = new Date(input.evidenceCutoffAt);

  const [qualityRows, productionRows, quoteRows, procurementOrders] = await Promise.all([
    tx.select({ inspection: qualityInspections, production: productionOrders })
      .from(qualityInspections)
      .innerJoin(productionOrders, eq(productionOrders.id, qualityInspections.productionOrderId))
      .where(and(
        eq(productionOrders.supplierId, input.supplierId),
        gte(qualityInspections.inspectedAt, start),
        lt(qualityInspections.inspectedAt, end),
        lte(qualityInspections.createdAt, cutoff),
      )),
    tx.select().from(productionOrders).where(and(
      eq(productionOrders.supplierId, input.supplierId),
      gte(productionOrders.createdAt, start),
      lt(productionOrders.createdAt, end),
      lte(productionOrders.createdAt, cutoff),
    )),
    tx.select({ quote: inventorySupplierQuoteVersions, rfq: inventoryProcurementRfqs })
      .from(inventorySupplierQuoteVersions)
      .innerJoin(inventoryProcurementRfqs, eq(inventoryProcurementRfqs.id, inventorySupplierQuoteVersions.rfqId))
      .where(and(
        eq(inventorySupplierQuoteVersions.supplierId, input.supplierId),
        eq(inventorySupplierQuoteVersions.versionNumber, 1),
        gte(inventorySupplierQuoteVersions.createdAt, start),
        lt(inventorySupplierQuoteVersions.createdAt, end),
        lte(inventorySupplierQuoteVersions.createdAt, cutoff),
      )),
    tx.select().from(inventoryPurchaseOrders).where(and(
      eq(inventoryPurchaseOrders.supplierId, input.supplierId),
      gte(inventoryPurchaseOrders.createdAt, start),
      lt(inventoryPurchaseOrders.createdAt, end),
      lte(inventoryPurchaseOrders.createdAt, cutoff),
    )),
  ]);

  const productionIds = [...new Set([
    ...productionRows.map((row) => row.id),
    ...qualityRows.map((row) => row.production.id),
  ])];
  const procurementIds = procurementOrders.map((row) => row.id);
  const [
    productionVersions,
    milestones,
    procurementVersions,
    procurementEvents,
    receipts,
    invoices,
  ] = await Promise.all([
    productionIds.length
      ? tx.select().from(productionOrderVersions).where(inArray(productionOrderVersions.productionOrderId, productionIds))
      : [],
    productionIds.length
      ? tx.select().from(productionMilestoneEvents).where(and(
          inArray(productionMilestoneEvents.productionOrderId, productionIds),
          lte(productionMilestoneEvents.recordedAt, cutoff),
        ))
      : [],
    procurementIds.length
      ? tx.select().from(inventoryPurchaseOrderVersions)
          .where(inArray(inventoryPurchaseOrderVersions.purchaseOrderId, procurementIds))
      : [],
    procurementIds.length
      ? tx.select().from(inventoryPurchaseOrderEvents).where(and(
          inArray(inventoryPurchaseOrderEvents.purchaseOrderId, procurementIds),
          lte(inventoryPurchaseOrderEvents.occurredAt, cutoff),
        ))
      : [],
    procurementIds.length
      ? tx.select().from(inventoryProcurementReceipts).where(and(
          inArray(inventoryProcurementReceipts.purchaseOrderId, procurementIds),
          gte(inventoryProcurementReceipts.receivedAt, start),
          lt(inventoryProcurementReceipts.receivedAt, end),
          lte(inventoryProcurementReceipts.createdAt, cutoff),
        ))
      : [],
    procurementIds.length
      ? tx.select().from(inventorySupplierInvoices).where(and(
          inArray(inventorySupplierInvoices.purchaseOrderId, procurementIds),
          gte(inventorySupplierInvoices.issuedAt, start),
          lt(inventorySupplierInvoices.issuedAt, end),
          lte(inventorySupplierInvoices.createdAt, cutoff),
        ))
      : [],
  ]);

  const capacities = await tx.select().from(supplierCapacityWindows).where(and(
    eq(supplierCapacityWindows.supplierId, input.supplierId),
    lt(supplierCapacityWindows.startsAt, end),
    gte(supplierCapacityWindows.endsAt, start),
    lte(supplierCapacityWindows.createdAt, cutoff),
  ));
  const latestProductionVersion = latestBy(productionVersions, (row) => row.productionOrderId, (row) => row.versionNumber);
  const latestProcurementVersion = latestBy(procurementVersions, (row) => row.purchaseOrderId, (row) => row.versionNumber);
  const milestonesByProduction = groupBy(milestones, (event) => event.productionOrderId);
  const latestCapacities = [...latestBy(
    capacities,
    (capacity) => capacity.windowKey,
    (capacity) => capacity.versionNumber,
  ).values()];

  const qualityNumerator = qualityRows.reduce((sum, row) => {
    const quantity = latestProductionVersion.get(row.production.id)?.quantity ?? 1;
    return sum + row.inspection.scoreBps * quantity;
  }, 0);
  const qualityDenominator = qualityRows.reduce((sum, row) =>
    sum + (latestProductionVersion.get(row.production.id)?.quantity ?? 1), 0);

  const productionCompletions = productionRows.flatMap((production) => {
    const completed = (milestonesByProduction.get(production.id) ?? [])
      .filter((event) => event.type === "completed" && event.occurredAt >= start && event.occurredAt < end)
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())[0];
    return completed ? [{ production, completed }] : [];
  });
  const procurementCompletionRows = receipts.flatMap((receipt) => {
    const version = procurementVersions.find((row) => row.id === receipt.purchaseOrderVersionId)
      ?? latestProcurementVersion.get(receipt.purchaseOrderId);
    return version ? [{ receipt, expectedAt: version.expectedAt }] : [];
  });
  const onTimeSamples = [
    ...productionCompletions.map(({ production, completed }) => ({
      onTime: completed.occurredAt <= production.expectedCompletionAt,
      reference: evidence("production_milestone_event", completed.id),
    })),
    ...procurementCompletionRows.map(({ receipt, expectedAt }) => ({
      onTime: receipt.receivedAt <= expectedAt,
      reference: evidence("inventory_procurement_receipt", receipt.id),
    })),
  ];

  const invoiceDenominator = invoices.reduce((sum, invoice) => sum + invoice.totalMinor, 0);
  const invoiceVariance = invoices.reduce((sum, invoice) => sum + Math.abs(invoice.varianceMinor), 0);
  const invoiceAccuracy = Math.max(0, invoiceDenominator - invoiceVariance);

  const responseTarget = definitions.find((definition) => definition.metric === "response_time")
    ?.responseTargetHours;
  const responseSamples = quoteRows.map(({ quote, rfq }) => ({
    withinTarget: responseTarget != null
      && quote.createdAt.getTime() - rfq.createdAt.getTime() <= responseTarget * 3_600_000,
    reference: evidence("inventory_supplier_quote_version", quote.id),
  }));

  const submittedEvents = milestones.filter((event) =>
    event.type === "submitted" && event.occurredAt >= start && event.occurredAt < end);
  const acknowledgedProduction = new Set(milestones
    .filter((event) => event.type === "acknowledged")
    .map((event) => event.productionOrderId));
  const cancelledProduction = new Set(milestones
    .filter((event) => event.type === "cancelled")
    .map((event) => event.productionOrderId));
  const cancelledProcurement = new Set(procurementEvents
    .filter((event) => event.action === "cancelled")
    .map((event) => event.purchaseOrderId));

  let capacityAssigned = 0;
  let capacityCompleted = 0;
  const capacityReferences: SupplierKpiEvidenceReference[] = [];
  for (const production of productionRows) {
    const capacity = latestCapacities.find((entry) =>
      production.createdAt >= entry.startsAt && production.createdAt < entry.endsAt);
    const version = latestProductionVersion.get(production.id);
    if (!capacity || !version) continue;
    capacityAssigned += version.quantity;
    const completed = (milestonesByProduction.get(production.id) ?? [])
      .find((event) => event.type === "completed" && event.occurredAt <= capacity.endsAt);
    if (completed) capacityCompleted += version.quantity;
    capacityReferences.push(evidence("supplier_capacity_window", capacity.id));
    capacityReferences.push(evidence("production_order", production.id));
  }

  const totalCancellationSamples = productionRows.length + procurementOrders.length;
  const nonCancelledSamples = totalCancellationSamples
    - cancelledProduction.size
    - cancelledProcurement.size;

  return [
    derived("quality", qualityRows.length, qualityNumerator, qualityDenominator, "weighted_bps",
      qualityRows.map((row) => evidence("quality_inspection", row.inspection.id))),
    derived("on_time_delivery", onTimeSamples.length, onTimeSamples.filter((sample) => sample.onTime).length,
      onTimeSamples.length, "sample_ratio", onTimeSamples.map((sample) => sample.reference)),
    derived("price_variance", invoices.length, invoiceAccuracy, invoiceDenominator, "money_ratio",
      invoices.map((invoice) => evidence("inventory_supplier_invoice", invoice.id))),
    derived("response_time", responseSamples.length,
      responseSamples.filter((sample) => sample.withinTarget).length, responseSamples.length,
      "sample_ratio", responseSamples.map((sample) => sample.reference)),
    derived("acceptance", submittedEvents.length,
      submittedEvents.filter((event) => acknowledgedProduction.has(event.productionOrderId)).length,
      submittedEvents.length, "sample_ratio",
      submittedEvents.map((event) => evidence("production_milestone_event", event.id))),
    derived("cancellation", totalCancellationSamples, nonCancelledSamples, totalCancellationSamples,
      "sample_ratio", [
        ...productionRows.map((row) => evidence("production_order", row.id)),
        ...procurementOrders.map((row) => evidence("inventory_purchase_order", row.id)),
      ]),
    derived("capacity_adherence", productionRows.length, capacityCompleted, capacityAssigned,
      "unit_ratio", uniqueEvidence(capacityReferences)),
  ];
}

function derived(
  metric: SupplierKpiMetric,
  sampleCount: number,
  rawNumerator: number,
  rawDenominator: number,
  rawUnit: SupplierKpiRawUnit,
  evidenceReferences: SupplierKpiEvidenceReference[],
): DerivedMetric {
  const scoreBps = rawDenominator > 0
    ? clamp(Math.round(
        rawUnit === "weighted_bps"
          ? rawNumerator / rawDenominator
          : rawNumerator * 10_000 / rawDenominator,
      ), 0, 10_000)
    : null;
  return {
    metric,
    scoreBps,
    sampleCount,
    rawNumerator: safeInteger(rawNumerator),
    rawDenominator: safeInteger(rawDenominator),
    rawUnit,
    evidenceReferences: uniqueEvidence(evidenceReferences),
  };
}

export function calculateOverall(
  metrics: DerivedMetric[],
  definitions: SupplierKpiMetricDefinition[],
  missingDataPolicy: DefinitionVersionRow["missingDataPolicy"],
): number | null {
  const byMetric = new Map(metrics.map((metric) => [metric.metric, metric]));
  const sufficient = definitions.map((definition) => ({
    definition,
    metric: byMetric.get(definition.metric),
  })).filter((entry) =>
    entry.metric?.scoreBps !== null
    && entry.metric !== undefined
    && entry.metric.sampleCount >= entry.definition.minimumSampleCount);

  if (missingDataPolicy === "incomplete" && sufficient.length !== definitions.length) return null;
  if (missingDataPolicy === "exclude" && !sufficient.length) return null;

  if (missingDataPolicy === "zero") {
    return Math.round(definitions.reduce((sum, definition) => {
      const metric = byMetric.get(definition.metric);
      const score = metric?.scoreBps !== null
        && metric !== undefined
        && metric.sampleCount >= definition.minimumSampleCount
        ? metric.scoreBps
        : 0;
      return sum + score * definition.weightBps;
    }, 0) / 10_000);
  }

  const weight = sufficient.reduce((sum, entry) => sum + entry.definition.weightBps, 0);
  if (!weight) return null;
  return Math.round(sufficient.reduce((sum, entry) =>
    sum + entry.metric!.scoreBps! * entry.definition.weightBps, 0) / weight);
}

function buildDiagnostics(
  metrics: DerivedMetric[],
  definitions: SupplierKpiMetricDefinition[],
): SupplierScorecardDiagnosticView {
  const byMetric = new Map(metrics.map((metric) => [metric.metric, metric]));
  const missingMetrics: SupplierKpiMetric[] = [];
  const insufficientSampleMetrics: SupplierKpiMetric[] = [];
  for (const definition of definitions) {
    const metric = byMetric.get(definition.metric);
    if (!metric || metric.scoreBps === null || metric.sampleCount === 0) {
      missingMetrics.push(definition.metric);
    } else if (metric.sampleCount < definition.minimumSampleCount) {
      insufficientSampleMetrics.push(definition.metric);
    }
  }
  return { missingMetrics, insufficientSampleMetrics };
}

async function definitionView(
  tx: TenantTransaction,
  definition: DefinitionRow,
): Promise<SupplierKpiDefinitionView> {
  const [version] = await tx.select().from(supplierKpiDefinitionVersions).where(and(
    eq(supplierKpiDefinitionVersions.definitionId, definition.id),
    eq(supplierKpiDefinitionVersions.versionNumber, definition.currentVersion),
  )).limit(1);
  if (!version) throw new NotFoundException("Supplier KPI definition version not found");
  return SupplierKpiDefinitionViewSchema.parse({
    id: definition.id,
    name: definition.name,
    currentVersion: definition.currentVersion,
    status: definition.status,
    version: {
      id: version.id,
      definitionId: version.definitionId,
      versionNumber: version.versionNumber,
      missingDataPolicy: version.missingDataPolicy,
      metrics: version.metrics,
      reasonCode: version.reasonCode,
      checksum: version.checksum,
      createdAt: version.createdAt.toISOString(),
    },
    createdAt: definition.createdAt.toISOString(),
    updatedAt: definition.updatedAt.toISOString(),
  });
}

async function scorecardView(
  tx: TenantTransaction,
  run: RunRow,
): Promise<SupplierScorecardRunView> {
  const metrics = await tx.select().from(supplierScorecardMetrics)
    .where(eq(supplierScorecardMetrics.runId, run.id))
    .orderBy(asc(supplierScorecardMetrics.metric));
  return SupplierScorecardRunViewSchema.parse({
    id: run.id,
    supplierId: run.supplierId,
    definitionId: run.definitionId,
    definitionVersionId: run.definitionVersionId,
    definitionVersion: run.definitionVersion,
    status: run.status,
    overallScoreBps: run.overallScoreBps,
    windowStart: run.windowStart.toISOString(),
    windowEnd: run.windowEnd.toISOString(),
    evidenceCutoffAt: run.evidenceCutoffAt.toISOString(),
    diagnostics: run.diagnostics,
    inputChecksum: run.inputChecksum,
    calculatedAt: run.calculatedAt.toISOString(),
    metrics: metrics.map((metric) => ({
      id: metric.id,
      metric: metric.metric,
      scoreBps: metric.scoreBps,
      sampleCount: metric.sampleCount,
      rawNumerator: metric.rawNumerator,
      rawDenominator: metric.rawDenominator,
      rawUnit: metric.rawUnit,
      evidenceReferences: metric.evidenceReferences,
    })),
  });
}

function latestBy<T>(
  rows: T[],
  key: (row: T) => string,
  version: (row: T) => number,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const current = result.get(key(row));
    if (!current || version(row) > version(current)) result.set(key(row), row);
  }
  return result;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}

function evidence(sourceType: string, sourceId: string): SupplierKpiEvidenceReference {
  return { sourceType, sourceId };
}

function uniqueEvidence(references: SupplierKpiEvidenceReference[]) {
  return [...new Map(references.map((reference) => [
    `${reference.sourceType}:${reference.sourceId}`,
    reference,
  ])).values()].sort(compareEvidence);
}

function compareEvidence(
  left: SupplierKpiEvidenceReference,
  right: SupplierKpiEvidenceReference,
) {
  return left.sourceType.localeCompare(right.sourceType) || left.sourceId.localeCompare(right.sourceId);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function safeInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UnprocessableEntityException("Supplier KPI value exceeds safe integer range");
  }
  return value;
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
