import { SecretVault } from "@yummyai/ai-core";
import { UnprocessableEntityException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, migrateDatabase, operatingMetricProjections, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { IntegrationService } from "../integrations/integration.service.js";
import { PlanningService } from "./planning.service.js";

describe.sequential("P3 forecasting and operating cockpit", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(); const tenantB = createEntityId(); const userA = createEntityId(); const userB = createEntityId();
  const contextA = context(tenantA, userA); const contextB = context(tenantB, userB);
  const audit = new AuditService(database);
  const integrations = new IntegrationService(database, new SecretVault(Buffer.alloc(32, 8)), { enqueue: vi.fn(async () => undefined) }, audit);
  const service = new PlanningService(database, audit, integrations);
  const profitRunA = createEntityId(); const profitRunB = createEntityId();
  let forecastId = ""; let definitionId = ""; let firstSnapshotId = "";

  beforeAll(async () => {
    await migrateDatabase(database);
    await seedTenant(tenantA, userA, profitRunA, "A");
    await seedTenant(tenantB, userB, profitRunB, "B");
  });
  afterAll(async () => database.client.end());

  it("generates pinned quantiles concurrently and rejects cross-tenant evidence", async () => {
    const input = forecastInput(tenantA, profitRunA);
    const runs = await Promise.all(Array.from({ length: 5 }, () => service.createForecast(contextA, input)));
    expect(new Set(runs.map((run) => run.id)).size).toBe(1);
    forecastId = runs[0]!.id;
    expect(runs[0]!.points).toHaveLength(2);
    expect(runs[0]!.points[0]!.values.map((entry) => entry.quantileBps)).toEqual([1000, 5000, 9000]);
    await expect(service.createForecast(contextA, { ...forecastInput(tenantA, profitRunB), idempotencyKey: `planning-cross-${tenantA}` })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect((await service.workspace(contextB)).forecasts).toHaveLength(0);
  });

  it("calculates accuracy and appends optimistic override versions", async () => {
    const run = await service.forecast(contextA, forecastId);
    const accuracy = await service.evaluateForecast(contextA, forecastId, { evaluationWindowStart: run.horizonStart, evaluationWindowEnd: run.horizonEnd, actualPoints: run.points.map((point, index) => ({ periodStart: point.periodStart, value: index ? 1250 : 1150, evidenceRefs: [{ sourceType: "profit_run", sourceId: profitRunA }] })), idempotencyKey: `planning-accuracy-${tenantA}` });
    expect(accuracy.meanAbsoluteError).toBeGreaterThanOrEqual(0);
    const override = await service.overrideForecast(contextA, forecastId, { expectedLatestVersion: 0, reasonCode: "MERCHANDISING_REVIEW", points: [{ periodStart: run.points[0]!.periodStart, medianValue: 1300 }], idempotencyKey: `planning-override-${tenantA}` });
    expect(override.versionNumber).toBe(1);
    expect((await service.forecast(contextA, forecastId)).overrides).toHaveLength(1);
  });

  it("opens freshness/completeness work and rebuilds a drifted projection", async () => {
    const definition = await service.upsertMetricDefinition(contextA, { definitionId: null, key: "forecast.profit.p50", name: "利润预测中位数", unit: "minor", source: "forecast", maximumAgeSeconds: 1, minimumCompletenessBps: 9_500, reasonCode: "P3_COCKPIT", idempotencyKey: `planning-definition-${tenantA}` });
    definitionId = definition.id;
    const first = await service.recordMetricSnapshot(contextA, { definitionId, expectedDefinitionVersion: 1, value: 1200, observedAt: "2026-07-01T00:00:00.000Z", completenessBps: 9_000, sourceRefs: [{ sourceType: "forecast_run", sourceId: forecastId }], drillThroughHref: "/operating-cockpit?forecast=profit", idempotencyKey: `planning-snapshot-1-${tenantA}` });
    firstSnapshotId = first.id;
    const second = await service.recordMetricSnapshot(contextA, { definitionId, expectedDefinitionVersion: 1, value: 1300, observedAt: "2026-07-02T00:00:00.000Z", completenessBps: 10_000, sourceRefs: [{ sourceType: "forecast_run", sourceId: forecastId }], drillThroughHref: "/operating-cockpit?forecast=profit", idempotencyKey: `planning-snapshot-2-${tenantA}` });
    expect(second.state).toBe("stale");
    const workspace = await service.workspace(contextA);
    expect(workspace.reconciliations.filter((item) => item.status === "open").length).toBeGreaterThanOrEqual(2);
    await withTenant(database.db, contextA, (tx) => tx.update(operatingMetricProjections).set({ snapshotId: firstSnapshotId }).where(eq(operatingMetricProjections.definitionId, definitionId)));
    const rebuild = await service.rebuildProjections(contextA, { idempotencyKey: `planning-rebuild-${tenantA}` });
    expect(rebuild).toMatchObject({ projectionCount: 1, equivalent: false });
    expect((await service.workspace(contextA)).metricProjections[0]!.snapshot.id).toBe(second.id);
  });

  it("keeps evidence append-only under the application role", async () => {
    const privileges = await withTenant(database.db, contextA, async (tx) => (await tx.execute(sql`select has_table_privilege(current_user, 'forecast_runs', 'UPDATE') as run_update, has_table_privilege(current_user, 'forecast_override_versions', 'DELETE') as override_delete, has_table_privilege(current_user, 'operating_reconciliation_events', 'UPDATE') as event_update, has_table_privilege(current_user, 'operating_metric_projections', 'UPDATE') as projection_update`))[0] as Record<string, boolean>);
    expect(privileges).toEqual({ run_update: false, override_delete: false, event_update: false, projection_update: true });
  });

  it("keeps a hundred forecast projections queryable under concurrent load", async () => {
    const inputs = Array.from({ length: 100 }, (_, index) => ({
      ...forecastInput(tenantA, profitRunA),
      scopeKey: `load-scope-${index}`,
      idempotencyKey: `planning-load-${tenantA}-${index}`,
    }));
    for (let index = 0; index < inputs.length; index += 20) {
      await Promise.all(inputs.slice(index, index + 20).map((input) => service.createForecast(contextA, input)));
    }
    const workspace = await service.workspace(contextA);
    expect(workspace.forecasts).toHaveLength(100);
    expect(new Set(workspace.forecasts.map((run) => run.scopeKey)).size).toBe(100);
  });

  async function seedTenant(tenantId: string, userId: string, profitRunId: string, suffix: string) {
    const metricId = createEntityId(); const versionId = createEntityId();
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3)", [tenantId, `Planning ${suffix}`, `planning-${suffix.toLowerCase()}-${tenantId}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4)", [userId, `planning-${suffix}-${userId}`, `planning-${suffix}-${userId}@example.test`, `Planning ${suffix}`]);
    await database.client.unsafe("insert into finance_profit_metrics (id,tenant_id,name,current_version,status,created_by) values ($1,$2,$3,1,'active',$4)", [metricId, tenantId, `Profit ${suffix}`, userId]);
    await database.client.unsafe("insert into finance_profit_metric_versions (id,tenant_id,metric_id,version_number,reporting_currency,revenue_fact_types,cost_fact_types,required_fact_types,reason_code,checksum,idempotency_key,created_by) values ($1,$2,$3,1,'USD','[]','[]','[]','P3','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',$4,$5)", [versionId, tenantId, metricId, `planning-profit-version-${suffix}`, userId]);
    await database.client.unsafe("insert into finance_profit_runs (id,tenant_id,metric_id,metric_version_id,reporting_currency,status,revenue_minor,cost_minor,profit_minor,margin_bps,statement_ids,fx_rate_ids,diagnostics,input_checksum,idempotency_key,calculated_by) values ($1,$2,$3,$4,'USD','complete',2000,800,1200,6000,'[]','[]','[]','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',$5,$6)", [profitRunId, tenantId, metricId, versionId, `planning-profit-run-${suffix}`, userId]);
  }
});

function context(tenantId: string, userId: string): TenantContext { return { tenantId, userId, permissions: ["forecast:read", "forecast:write", "forecast:review", "operations:read", "operations:write", "operations:reconcile", "integration:read", "integration:manage"], dataScope: "tenant" }; }
function forecastInput(tenantId: string, sourceId: string) { return { metric: "profit_minor" as const, scopeType: "tenant" as const, scopeKey: tenantId, grain: "day" as const, model: "moving_average_v1" as const, modelVersion: "2026.07.1", inputWindowStart: "2026-07-01T00:00:00.000Z", inputWindowEnd: "2026-07-03T00:00:00.000Z", evidenceCutoffAt: "2026-07-03T01:00:00.000Z", horizonStart: "2026-07-03T00:00:00.000Z", horizonEnd: "2026-07-05T00:00:00.000Z", quantilesBps: [1000, 5000, 9000], inputPoints: [{ periodStart: "2026-07-01T00:00:00.000Z", value: 1000, evidenceRefs: [{ sourceType: "profit_run" as const, sourceId }] }, { periodStart: "2026-07-02T00:00:00.000Z", value: 1200, evidenceRefs: [{ sourceType: "profit_run" as const, sourceId }] }], idempotencyKey: `planning-forecast-${tenantId}` }; }
