import { createHash } from "node:crypto";

import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  CreateForecastRunInputSchema, EvaluateForecastInputSchema, ForecastAccuracyViewSchema, ForecastOverrideViewSchema,
  ForecastPointViewSchema, ForecastRunViewSchema, OpenOperatingReconciliationInputSchema, OperatingMetricDefinitionViewSchema,
  OperatingMetricProjectionViewSchema, OperatingMetricSnapshotViewSchema, OperatingProjectionRebuildViewSchema,
  OperatingReconciliationViewSchema, OverrideForecastInputSchema, PlanningWorkspaceViewSchema,
  RebuildOperatingProjectionsInputSchema, RecordOperatingMetricSnapshotInputSchema, ResolveOperatingReconciliationInputSchema,
  UpsertOperatingMetricDefinitionInputSchema, createEntityId,
  type CreateForecastRunInput, type EvaluateForecastInput, type ForecastInputPoint, type ForecastRunView,
  type OpenOperatingReconciliationInput, type OverrideForecastInput, type PlanningWorkspaceView,
  type RebuildOperatingProjectionsInput, type RecordOperatingMetricSnapshotInput,
  type ResolveOperatingReconciliationInput, type TenantContext, type UpsertOperatingMetricDefinitionInput,
} from "@yummyai/contracts";
import {
  financeProfitRuns, forecastAccuracyEvaluations, forecastOverrideVersions, forecastPoints, forecastRuns,
  inventoryMovements, operatingMetricDefinitions, operatingMetricDefinitionVersions, operatingMetricProjections,
  operatingMetricSnapshots, operatingProjectionRebuilds, operatingReconciliationEvents, operatingReconciliations,
  orderEvents, webhookDeliveries, type DatabaseConnection, type TenantTransaction, withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { IntegrationService } from "../integrations/integration.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

@Injectable()
export class PlanningService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntegrationService) private readonly integrations: IntegrationService,
  ) {}

  async createForecast(context: TenantContext, rawInput: CreateForecastRunInput) {
    const input = CreateForecastRunInputSchema.parse(rawInput);
    const inputChecksum = hash({ ...input, idempotencyKey: undefined });
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `forecast:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(forecastRuns).where(eq(forecastRuns.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.inputChecksum !== inputChecksum) throw new ConflictException("Forecast idempotency key was reused with changed input");
        return { row: replayed, created: false };
      }
      await validateForecastEvidence(tx, input.inputPoints);
      const id = createEntityId();
      const [row] = await tx.insert(forecastRuns).values({
        id, tenantId: context.tenantId, metric: input.metric, scopeType: input.scopeType, scopeKey: input.scopeKey,
        grain: input.grain, model: input.model, modelVersion: input.modelVersion,
        inputWindowStart: new Date(input.inputWindowStart), inputWindowEnd: new Date(input.inputWindowEnd), evidenceCutoffAt: new Date(input.evidenceCutoffAt),
        horizonStart: new Date(input.horizonStart), horizonEnd: new Date(input.horizonEnd), quantilesBps: input.quantilesBps,
        inputPoints: input.inputPoints, inputChecksum, idempotencyKey: input.idempotencyKey, generatedBy: context.userId,
      }).returning();
      const points = calculateForecastPoints(input).map((point) => ({ id: createEntityId(), tenantId: context.tenantId, runId: id, periodStart: point.periodStart, values: point.values }));
      if (points.length) await tx.insert(forecastPoints).values(points);
      return { row: row!, created: true };
    });
    const view = await this.forecast(context, result.row.id);
    if (result.created) await this.integrations.publishEvent(context, { eventType: "forecast.completed", resourceType: "forecast_run", resourceId: view.id, payload: { metric: view.metric, scopeType: view.scopeType, scopeKey: view.scopeKey, grain: view.grain, model: view.model, modelVersion: view.modelVersion, horizonStart: view.horizonStart, horizonEnd: view.horizonEnd, inputChecksum: view.inputChecksum }, occurredAt: view.generatedAt, idempotencyKey: `forecast-event:${view.id}` });
    await this.audit.record(context, { action: "planning.forecast.create", resourceType: "forecast_run", resourceId: view.id, result: "success", metadata: { metric: view.metric, model: view.model, pointCount: view.points.length } });
    return view;
  }

  async evaluateForecast(context: TenantContext, runId: string, rawInput: EvaluateForecastInput) {
    const input = EvaluateForecastInputSchema.parse(rawInput);
    const row = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `forecast:${runId}`);
      const [replayed] = await tx.select().from(forecastAccuracyEvaluations).where(eq(forecastAccuracyEvaluations.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return replayed;
      const [run] = await tx.select().from(forecastRuns).where(eq(forecastRuns.id, runId)).limit(1);
      if (!run) throw new NotFoundException("Forecast run not found");
      const parsed = CreateForecastRunInputSchema.shape.metric.parse(run.metric);
      const expectedType = parsed === "sales_units" ? "order_event" : parsed === "inventory_available" ? "inventory_movement" : "profit_run";
      if (input.actualPoints.some((point) => point.evidenceRefs.some((reference) => reference.sourceType !== expectedType))) throw new UnprocessableEntityException("Forecast actual evidence type does not match the run metric");
      await validateForecastEvidence(tx, input.actualPoints);
      const points = await tx.select().from(forecastPoints).where(eq(forecastPoints.runId, runId));
      const medians = new Map(points.map((point) => [point.periodStart.toISOString(), point.values.find((value) => value.quantileBps === 5_000)?.value]));
      const pairs = input.actualPoints.map((actual) => ({ actual: actual.value, predicted: medians.get(actual.periodStart) })).filter((pair): pair is { actual: number; predicted: number } => pair.predicted !== undefined);
      if (!pairs.length || pairs.length !== input.actualPoints.length) throw new UnprocessableEntityException("Every actual point must match a forecast horizon period");
      const absoluteError = pairs.reduce((sum, pair) => sum + Math.abs(pair.predicted - pair.actual), 0);
      const actualTotal = pairs.reduce((sum, pair) => sum + Math.abs(pair.actual), 0);
      const bias = pairs.reduce((sum, pair) => sum + pair.predicted - pair.actual, 0);
      const evidenceRefs = uniqueRefs(input.actualPoints.flatMap((point) => point.evidenceRefs));
      const [created] = await tx.insert(forecastAccuracyEvaluations).values({ id: createEntityId(), tenantId: context.tenantId, runId, evaluationWindowStart: new Date(input.evaluationWindowStart), evaluationWindowEnd: new Date(input.evaluationWindowEnd), actualEvidenceRefs: evidenceRefs, meanAbsoluteError: Math.round(absoluteError / pairs.length), weightedAbsolutePercentageErrorBps: actualTotal ? Math.round((absoluteError * 10_000) / actualTotal) : null, biasBps: actualTotal ? Math.round((bias * 10_000) / actualTotal) : null, inputChecksum: hash(input), idempotencyKey: input.idempotencyKey, evaluatedBy: context.userId }).returning();
      return created!;
    });
    return accuracyView(row);
  }

  async overrideForecast(context: TenantContext, runId: string, rawInput: OverrideForecastInput) {
    const input = OverrideForecastInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `forecast:${runId}`);
      const [replayed] = await tx.select().from(forecastOverrideVersions).where(eq(forecastOverrideVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return { row: replayed, created: false };
      const [run] = await tx.select().from(forecastRuns).where(eq(forecastRuns.id, runId)).limit(1);
      if (!run) throw new NotFoundException("Forecast run not found");
      const [latest] = await tx.select().from(forecastOverrideVersions).where(eq(forecastOverrideVersions.runId, runId)).orderBy(desc(forecastOverrideVersions.versionNumber)).limit(1);
      const latestVersion = latest?.versionNumber ?? 0;
      if (latestVersion !== input.expectedLatestVersion) throw new ConflictException("Forecast override version changed");
      const allowedPeriods = new Set((await tx.select({ periodStart: forecastPoints.periodStart }).from(forecastPoints).where(eq(forecastPoints.runId, runId))).map((point) => point.periodStart.toISOString()));
      if (input.points.some((point) => !allowedPeriods.has(point.periodStart))) throw new UnprocessableEntityException("Forecast override point is outside the run horizon");
      if (run.metric !== "profit_minor" && input.points.some((point) => point.medianValue < 0)) throw new UnprocessableEntityException("Sales and inventory overrides cannot be negative");
      const [created] = await tx.insert(forecastOverrideVersions).values({ id: createEntityId(), tenantId: context.tenantId, runId, versionNumber: latestVersion + 1, reasonCode: input.reasonCode, points: input.points, checksum: hash(input.points), idempotencyKey: input.idempotencyKey, createdBy: context.userId }).returning();
      return { row: created!, created: true };
    });
    const view = overrideView(result.row);
    if (result.created) await this.integrations.publishEvent(context, { eventType: "forecast.overridden", resourceType: "forecast_run", resourceId: runId, payload: { overrideVersion: view.versionNumber, reasonCode: view.reasonCode, checksum: view.checksum }, occurredAt: view.createdAt, idempotencyKey: `forecast-override-event:${view.id}` });
    return view;
  }

  async upsertMetricDefinition(context: TenantContext, rawInput: UpsertOperatingMetricDefinitionInput) {
    const input = UpsertOperatingMetricDefinitionInputSchema.parse(rawInput);
    const row = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `operating-metric:${input.definitionId ?? input.key}`);
      const [replayed] = await tx.select().from(operatingMetricDefinitionVersions).where(eq(operatingMetricDefinitionVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) { const [definition] = await tx.select().from(operatingMetricDefinitions).where(eq(operatingMetricDefinitions.id, replayed.definitionId)).limit(1); return definition!; }
      const [existing] = input.definitionId ? await tx.select().from(operatingMetricDefinitions).where(eq(operatingMetricDefinitions.id, input.definitionId)).limit(1) : [];
      if (input.definitionId && !existing) throw new NotFoundException("Operating metric definition not found");
      const definitionId = existing?.id ?? createEntityId();
      const versionNumber = (existing?.currentVersion ?? 0) + 1;
      if (existing) await tx.update(operatingMetricDefinitions).set({ name: input.name, currentVersion: versionNumber, updatedAt: new Date() }).where(eq(operatingMetricDefinitions.id, definitionId));
      else await tx.insert(operatingMetricDefinitions).values({ id: definitionId, tenantId: context.tenantId, key: input.key, name: input.name, createdBy: context.userId });
      await tx.insert(operatingMetricDefinitionVersions).values({ id: createEntityId(), tenantId: context.tenantId, definitionId, versionNumber, unit: input.unit, source: input.source, maximumAgeSeconds: input.maximumAgeSeconds, minimumCompletenessBps: input.minimumCompletenessBps, reasonCode: input.reasonCode, checksum: hash({ unit: input.unit, source: input.source, maximumAgeSeconds: input.maximumAgeSeconds, minimumCompletenessBps: input.minimumCompletenessBps }), idempotencyKey: input.idempotencyKey, createdBy: context.userId });
      const [definition] = await tx.select().from(operatingMetricDefinitions).where(eq(operatingMetricDefinitions.id, definitionId)).limit(1);
      return definition!;
    });
    return withTenant(this.database.db, context, (tx) => metricDefinitionView(tx, row));
  }

  async recordMetricSnapshot(context: TenantContext, rawInput: RecordOperatingMetricSnapshotInput) {
    const input = RecordOperatingMetricSnapshotInputSchema.parse(rawInput);
    const row = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `operating-metric:${input.definitionId}`);
      const [replayed] = await tx.select().from(operatingMetricSnapshots).where(eq(operatingMetricSnapshots.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return replayed;
      const [definition] = await tx.select().from(operatingMetricDefinitions).where(eq(operatingMetricDefinitions.id, input.definitionId)).limit(1);
      if (!definition) throw new NotFoundException("Operating metric definition not found");
      if (definition.currentVersion !== input.expectedDefinitionVersion) throw new ConflictException("Operating metric definition version changed");
      const [version] = await tx.select().from(operatingMetricDefinitionVersions).where(and(eq(operatingMetricDefinitionVersions.definitionId, definition.id), eq(operatingMetricDefinitionVersions.versionNumber, input.expectedDefinitionVersion))).limit(1);
      if (!version) throw new NotFoundException("Operating metric definition version not found");
      await validateOperatingEvidence(tx, version.source, input.sourceRefs);
      const [created] = await tx.insert(operatingMetricSnapshots).values({ id: createEntityId(), tenantId: context.tenantId, definitionId: definition.id, definitionVersionId: version.id, definitionVersion: version.versionNumber, value: input.value, observedAt: new Date(input.observedAt), completenessBps: input.completenessBps, sourceRefs: input.sourceRefs, drillThroughHref: input.drillThroughHref, checksum: hash({ ...input, idempotencyKey: undefined }), idempotencyKey: input.idempotencyKey, recordedBy: context.userId }).returning();
      await tx.insert(operatingMetricProjections).values({ tenantId: context.tenantId, definitionId: definition.id, snapshotId: created!.id }).onConflictDoUpdate({ target: [operatingMetricProjections.tenantId, operatingMetricProjections.definitionId], set: { snapshotId: created!.id, updatedAt: new Date() } });
      const ageSeconds = Math.max(0, Math.floor((Date.now() - created!.observedAt.getTime()) / 1000));
      if (input.value === null || input.completenessBps < version.minimumCompletenessBps) await insertReconciliation(tx, context, { category: "completeness", code: input.value === null ? "METRIC_UNAVAILABLE" : "METRIC_INCOMPLETE", metricSnapshotId: created!.id, sourceRef: input.sourceRefs[0] ?? null, detailChecksum: hash({ definitionId: definition.id, completenessBps: input.completenessBps }), idempotencyKey: `metric-completeness:${created!.id}` });
      if (ageSeconds > version.maximumAgeSeconds) await insertReconciliation(tx, context, { category: "freshness", code: "METRIC_STALE", metricSnapshotId: created!.id, sourceRef: input.sourceRefs[0] ?? null, detailChecksum: hash({ definitionId: definition.id, ageSeconds }), idempotencyKey: `metric-freshness:${created!.id}` });
      return created!;
    });
    return withTenant(this.database.db, context, async (tx) => { const [version] = await tx.select().from(operatingMetricDefinitionVersions).where(eq(operatingMetricDefinitionVersions.id, row.definitionVersionId)).limit(1); return metricSnapshotView(row, version!); });
  }

  async openReconciliation(context: TenantContext, rawInput: OpenOperatingReconciliationInput) {
    const input = OpenOperatingReconciliationInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => ({ row: await insertReconciliation(tx, context, input), created: !(await tx.select().from(operatingReconciliationEvents).where(eq(operatingReconciliationEvents.idempotencyKey, input.idempotencyKey)).limit(1)).length }));
    const view = reconciliationView(result.row);
    await this.integrations.publishEvent(context, { eventType: "operating.reconciliation.opened", resourceType: "operating_reconciliation", resourceId: view.id, payload: { category: view.category, code: view.code, detailChecksum: view.detailChecksum }, occurredAt: view.openedAt, idempotencyKey: `operating-open-event:${view.id}` });
    return view;
  }

  async resolveReconciliation(context: TenantContext, reconciliationId: string, rawInput: ResolveOperatingReconciliationInput) {
    const input = ResolveOperatingReconciliationInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `operating-reconciliation:${reconciliationId}`);
      const [event] = await tx.select().from(operatingReconciliationEvents).where(and(eq(operatingReconciliationEvents.reconciliationId, reconciliationId), eq(operatingReconciliationEvents.idempotencyKey, input.idempotencyKey))).limit(1);
      const [row] = await tx.select().from(operatingReconciliations).where(eq(operatingReconciliations.id, reconciliationId)).limit(1);
      if (!row) throw new NotFoundException("Operating reconciliation not found");
      if (event) return { row, changed: false };
      if (row.status !== input.expectedStatus) throw new ConflictException("Operating reconciliation is no longer open");
      await tx.insert(operatingReconciliationEvents).values({ id: createEntityId(), tenantId: context.tenantId, reconciliationId, action: input.outcome, fromStatus: row.status, toStatus: input.outcome, reasonCode: input.reasonCode, idempotencyKey: input.idempotencyKey, actorUserId: context.userId });
      const [updated] = await tx.update(operatingReconciliations).set({ status: input.outcome, resolvedAt: new Date() }).where(eq(operatingReconciliations.id, reconciliationId)).returning();
      return { row: updated!, changed: true };
    });
    const view = reconciliationView(result.row);
    if (result.changed) await this.integrations.publishEvent(context, { eventType: "operating.reconciliation.resolved", resourceType: "operating_reconciliation", resourceId: view.id, payload: { category: view.category, code: view.code, outcome: view.status }, occurredAt: view.resolvedAt!, idempotencyKey: `operating-resolved-event:${view.id}:${view.status}` });
    return view;
  }

  async rebuildProjections(context: TenantContext, rawInput: RebuildOperatingProjectionsInput) {
    const input = RebuildOperatingProjectionsInputSchema.parse(rawInput);
    const row = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `operating-projections:${context.tenantId}`);
      const [replayed] = await tx.select().from(operatingProjectionRebuilds).where(eq(operatingProjectionRebuilds.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return replayed;
      const before = await tx.select().from(operatingMetricProjections).orderBy(asc(operatingMetricProjections.definitionId));
      const snapshots = await tx.select().from(operatingMetricSnapshots).orderBy(asc(operatingMetricSnapshots.definitionId), desc(operatingMetricSnapshots.observedAt), desc(operatingMetricSnapshots.recordedAt));
      const latestByDefinition = new Map<string, (typeof snapshots)[number]>();
      for (const snapshot of snapshots) {
        if (!latestByDefinition.has(snapshot.definitionId)) latestByDefinition.set(snapshot.definitionId, snapshot);
      }
      const latest = [...latestByDefinition.values()];
      await tx.delete(operatingMetricProjections);
      if (latest.length) await tx.insert(operatingMetricProjections).values(latest.map((snapshot) => ({ tenantId: context.tenantId, definitionId: snapshot.definitionId, snapshotId: snapshot.id })));
      const after = await tx.select().from(operatingMetricProjections).orderBy(asc(operatingMetricProjections.definitionId));
      const beforeChecksum = projectionChecksum(before); const afterChecksum = projectionChecksum(after);
      const [created] = await tx.insert(operatingProjectionRebuilds).values({ id: createEntityId(), tenantId: context.tenantId, sourceSnapshotCount: snapshots.length, projectionCount: after.length, beforeChecksum, afterChecksum, equivalent: beforeChecksum === afterChecksum, idempotencyKey: input.idempotencyKey, rebuiltBy: context.userId }).returning();
      return created!;
    });
    return rebuildView(row);
  }

  async forecast(context: TenantContext, runId: string): Promise<ForecastRunView> {
    return withTenant(this.database.db, context, async (tx) => { const [run] = await tx.select().from(forecastRuns).where(eq(forecastRuns.id, runId)).limit(1); if (!run) throw new NotFoundException("Forecast run not found"); return forecastView(tx, run); });
  }

  async workspace(context: TenantContext): Promise<PlanningWorkspaceView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [runs, definitions, projections, reconciliations, rebuilds] = await Promise.all([
        tx.select().from(forecastRuns).orderBy(desc(forecastRuns.generatedAt)).limit(100), tx.select().from(operatingMetricDefinitions).orderBy(asc(operatingMetricDefinitions.name)).limit(100), tx.select().from(operatingMetricProjections).orderBy(desc(operatingMetricProjections.updatedAt)).limit(100), tx.select().from(operatingReconciliations).orderBy(desc(operatingReconciliations.openedAt)).limit(200), tx.select().from(operatingProjectionRebuilds).orderBy(desc(operatingProjectionRebuilds.rebuiltAt)).limit(20),
      ]);
      return PlanningWorkspaceViewSchema.parse({ forecasts: await Promise.all(runs.map((run) => forecastView(tx, run))), metricDefinitions: await Promise.all(definitions.map((definition) => metricDefinitionView(tx, definition))), metricProjections: await Promise.all(projections.map(async (projection) => { const [snapshot] = await tx.select().from(operatingMetricSnapshots).where(eq(operatingMetricSnapshots.id, projection.snapshotId)).limit(1); const [version] = snapshot ? await tx.select().from(operatingMetricDefinitionVersions).where(eq(operatingMetricDefinitionVersions.id, snapshot.definitionVersionId)).limit(1) : []; if (!snapshot || !version) throw new NotFoundException("Operating metric projection source is missing"); return OperatingMetricProjectionViewSchema.parse({ definitionId: projection.definitionId, snapshot: metricSnapshotView(snapshot, version) }); })), reconciliations: reconciliations.map(reconciliationView), rebuilds: rebuilds.map(rebuildView) });
    });
  }
}

function calculateForecastPoints(input: CreateForecastRunInput) {
  const values = input.inputPoints.map((point) => point.value);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const spread = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  const periods: Date[] = [];
  for (let cursor = new Date(input.horizonStart); cursor < new Date(input.horizonEnd) && periods.length < 5_000; cursor = addGrain(cursor, input.grain)) periods.push(cursor);
  return periods.map((periodStart, index) => {
    const median = input.model === "moving_average_v1" ? average(values.slice(-Math.min(3, values.length))) : values[(values.length - periods.length + index + values.length * 10_000) % values.length]!;
    return { periodStart, values: input.quantilesBps.map((quantileBps) => ({ quantileBps, value: normalizeForecastValue(median + ((quantileBps - 5_000) / 4_000) * spread, input.metric) })) };
  });
}
function addGrain(value: Date, grain: CreateForecastRunInput["grain"]) { const next = new Date(value); if (grain === "day") next.setUTCDate(next.getUTCDate() + 1); else if (grain === "week") next.setUTCDate(next.getUTCDate() + 7); else next.setUTCMonth(next.getUTCMonth() + 1); return next; }
function normalizeForecastValue(value: number, metric: CreateForecastRunInput["metric"]) { return Math.round(metric === "profit_minor" ? value : Math.max(0, value)); }
function average(values: number[]) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
async function validateForecastEvidence(tx: TenantTransaction, points: ForecastInputPoint[]) { const grouped = { order_event: new Set<string>(), inventory_movement: new Set<string>(), profit_run: new Set<string>() }; for (const reference of points.flatMap((point) => point.evidenceRefs)) grouped[reference.sourceType].add(reference.sourceId); await Promise.all([validateOrderEventIds(tx, grouped.order_event), validateInventoryMovementIds(tx, grouped.inventory_movement), validateProfitRunIds(tx, grouped.profit_run)]); }
async function validateOperatingEvidence(tx: TenantTransaction, source: string, refs: { sourceType: string; sourceId: string }[]) { const expected = source === "forecast" ? "forecast_run" : source === "inventory" ? "inventory_movement" : source === "finance" ? "finance_profit_run" : source === "webhook" ? "webhook_delivery" : "operating_projection_rebuild"; if (refs.some((ref) => ref.sourceType !== expected)) throw new UnprocessableEntityException("Operating metric source evidence type does not match its definition"); const ids = new Set(refs.map((ref) => ref.sourceId)); if (!ids.size) return; if (source === "forecast") await validateForecastRunIds(tx, ids); else if (source === "inventory") await validateInventoryMovementIds(tx, ids); else if (source === "finance") await validateProfitRunIds(tx, ids); else if (source === "webhook") await validateWebhookDeliveryIds(tx, ids); else await validateProjectionRebuildIds(tx, ids); }
async function validateOrderEventIds(tx: TenantTransaction, ids: Set<string>) { return validateFoundIds(ids, await tx.select({ id: orderEvents.id }).from(orderEvents).where(inArray(orderEvents.id, [...ids]))); }
async function validateInventoryMovementIds(tx: TenantTransaction, ids: Set<string>) { return validateFoundIds(ids, await tx.select({ id: inventoryMovements.id }).from(inventoryMovements).where(inArray(inventoryMovements.id, [...ids]))); }
async function validateProfitRunIds(tx: TenantTransaction, ids: Set<string>) { return validateFoundIds(ids, await tx.select({ id: financeProfitRuns.id }).from(financeProfitRuns).where(inArray(financeProfitRuns.id, [...ids]))); }
async function validateForecastRunIds(tx: TenantTransaction, ids: Set<string>) { return validateFoundIds(ids, await tx.select({ id: forecastRuns.id }).from(forecastRuns).where(inArray(forecastRuns.id, [...ids]))); }
async function validateWebhookDeliveryIds(tx: TenantTransaction, ids: Set<string>) { return validateFoundIds(ids, await tx.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(inArray(webhookDeliveries.id, [...ids]))); }
async function validateProjectionRebuildIds(tx: TenantTransaction, ids: Set<string>) { return validateFoundIds(ids, await tx.select({ id: operatingProjectionRebuilds.id }).from(operatingProjectionRebuilds).where(inArray(operatingProjectionRebuilds.id, [...ids]))); }
function validateFoundIds(ids: Set<string>, rows: { id: string }[]) { if (rows.length !== ids.size) throw new UnprocessableEntityException("Forecast or operating source evidence was not found in this tenant"); }
async function forecastView(tx: TenantTransaction, run: typeof forecastRuns.$inferSelect) { const [points, accuracy, overrides] = await Promise.all([tx.select().from(forecastPoints).where(eq(forecastPoints.runId, run.id)).orderBy(asc(forecastPoints.periodStart)), tx.select().from(forecastAccuracyEvaluations).where(eq(forecastAccuracyEvaluations.runId, run.id)).orderBy(desc(forecastAccuracyEvaluations.evaluatedAt)), tx.select().from(forecastOverrideVersions).where(eq(forecastOverrideVersions.runId, run.id)).orderBy(asc(forecastOverrideVersions.versionNumber))]); return ForecastRunViewSchema.parse({ id: run.id, metric: run.metric, scopeType: run.scopeType, scopeKey: run.scopeKey, grain: run.grain, model: run.model, modelVersion: run.modelVersion, inputWindowStart: run.inputWindowStart.toISOString(), inputWindowEnd: run.inputWindowEnd.toISOString(), evidenceCutoffAt: run.evidenceCutoffAt.toISOString(), horizonStart: run.horizonStart.toISOString(), horizonEnd: run.horizonEnd.toISOString(), quantilesBps: run.quantilesBps, inputPoints: run.inputPoints, inputChecksum: run.inputChecksum, generatedAt: run.generatedAt.toISOString(), points: points.map((point) => ForecastPointViewSchema.parse({ id: point.id, periodStart: point.periodStart.toISOString(), values: point.values })), accuracy: accuracy.map(accuracyView), overrides: overrides.map(overrideView) }); }
function accuracyView(row: typeof forecastAccuracyEvaluations.$inferSelect) { return ForecastAccuracyViewSchema.parse({ id: row.id, evaluationWindowStart: row.evaluationWindowStart.toISOString(), evaluationWindowEnd: row.evaluationWindowEnd.toISOString(), actualEvidenceRefs: row.actualEvidenceRefs, meanAbsoluteError: row.meanAbsoluteError, weightedAbsolutePercentageErrorBps: row.weightedAbsolutePercentageErrorBps, biasBps: row.biasBps, inputChecksum: row.inputChecksum, evaluatedAt: row.evaluatedAt.toISOString() }); }
function overrideView(row: typeof forecastOverrideVersions.$inferSelect) { return ForecastOverrideViewSchema.parse({ id: row.id, versionNumber: row.versionNumber, reasonCode: row.reasonCode, points: row.points, checksum: row.checksum, createdAt: row.createdAt.toISOString() }); }
async function metricDefinitionView(tx: TenantTransaction, row: typeof operatingMetricDefinitions.$inferSelect) { const [version] = await tx.select().from(operatingMetricDefinitionVersions).where(and(eq(operatingMetricDefinitionVersions.definitionId, row.id), eq(operatingMetricDefinitionVersions.versionNumber, row.currentVersion))).limit(1); if (!version) throw new NotFoundException("Operating metric definition version not found"); return OperatingMetricDefinitionViewSchema.parse({ id: row.id, key: row.key, name: row.name, currentVersion: row.currentVersion, status: row.status, version: { id: version.id, versionNumber: version.versionNumber, unit: version.unit, source: version.source, maximumAgeSeconds: version.maximumAgeSeconds, minimumCompletenessBps: version.minimumCompletenessBps, reasonCode: version.reasonCode, checksum: version.checksum, createdAt: version.createdAt.toISOString() }, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }); }
function metricSnapshotView(row: typeof operatingMetricSnapshots.$inferSelect, version: typeof operatingMetricDefinitionVersions.$inferSelect) { const ageSeconds = Math.max(0, Math.floor((Date.now() - row.observedAt.getTime()) / 1_000)); const state = row.value === null ? "unavailable" : row.completenessBps < version.minimumCompletenessBps ? "incomplete" : ageSeconds > version.maximumAgeSeconds ? "stale" : "current"; return OperatingMetricSnapshotViewSchema.parse({ id: row.id, definitionId: row.definitionId, definitionVersionId: row.definitionVersionId, definitionVersion: row.definitionVersion, value: row.value, observedAt: row.observedAt.toISOString(), recordedAt: row.recordedAt.toISOString(), completenessBps: row.completenessBps, sourceRefs: row.sourceRefs, drillThroughHref: row.drillThroughHref, checksum: row.checksum, state, ageSeconds }); }
async function insertReconciliation(tx: TenantTransaction, context: TenantContext, input: OpenOperatingReconciliationInput) { await lock(tx, `operating-reconciliation:${input.idempotencyKey}`); const [replayed] = await tx.select().from(operatingReconciliations).where(eq(operatingReconciliations.idempotencyKey, input.idempotencyKey)).limit(1); if (replayed) return replayed; if (input.metricSnapshotId) { const [snapshot] = await tx.select({ id: operatingMetricSnapshots.id }).from(operatingMetricSnapshots).where(eq(operatingMetricSnapshots.id, input.metricSnapshotId)).limit(1); if (!snapshot) throw new NotFoundException("Operating metric snapshot not found"); } const id = createEntityId(); const [created] = await tx.insert(operatingReconciliations).values({ id, tenantId: context.tenantId, category: input.category, code: input.code, metricSnapshotId: input.metricSnapshotId, sourceRef: input.sourceRef, detailChecksum: input.detailChecksum, idempotencyKey: input.idempotencyKey, openedBy: context.userId }).returning(); await tx.insert(operatingReconciliationEvents).values({ id: createEntityId(), tenantId: context.tenantId, reconciliationId: id, action: "opened", fromStatus: null, toStatus: "open", reasonCode: input.code, idempotencyKey: input.idempotencyKey, actorUserId: context.userId }); return created!; }
function reconciliationView(row: typeof operatingReconciliations.$inferSelect) { return OperatingReconciliationViewSchema.parse({ id: row.id, category: row.category, code: row.code, status: row.status, metricSnapshotId: row.metricSnapshotId, sourceRef: row.sourceRef, detailChecksum: row.detailChecksum, openedAt: row.openedAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString() ?? null }); }
function projectionChecksum(rows: { definitionId: string; snapshotId: string }[]) { return hash(rows.map((row) => ({ definitionId: row.definitionId, snapshotId: row.snapshotId })).sort((left, right) => left.definitionId.localeCompare(right.definitionId))); }
function rebuildView(row: typeof operatingProjectionRebuilds.$inferSelect) { return OperatingProjectionRebuildViewSchema.parse({ id: row.id, sourceSnapshotCount: row.sourceSnapshotCount, projectionCount: row.projectionCount, beforeChecksum: row.beforeChecksum, afterChecksum: row.afterChecksum, equivalent: row.equivalent, rebuiltAt: row.rebuiltAt.toISOString() }); }
function uniqueRefs(refs: { sourceType: "order_event" | "inventory_movement" | "profit_run"; sourceId: string }[]) { return [...new Map(refs.map((ref) => [`${ref.sourceType}:${ref.sourceId}`, ref])).values()]; }
async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }
function hash(value: unknown) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`; return JSON.stringify(value); }
