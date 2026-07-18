import { Permission } from "@yummyai/authz";
import { createEntityId, type AnalysisReport, type TenantContext } from "@yummyai/contracts";
import { analysisReports, connectDatabase, migrateDatabase, withTenant } from "@yummyai/database";
import type { JobEnvelope } from "@yummyai/jobs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AnalysisController } from "./analysis.controller.js";
import { AnalysisService, type AnalysisJobEnqueuer } from "./analysis.service.js";

describe("analysis report API", () => {
  const database = connectDatabase();
  const tenantId = createEntityId();
  const otherTenantId = createEntityId();
  const userId = createEntityId();
  const snapshotId = createEntityId();
  const reportSeriesId = createEntityId();
  let enqueued: JobEnvelope | undefined;
  const jobs: AnalysisJobEnqueuer = { enqueue: async (envelope) => { enqueued = envelope; } };
  const service = new AnalysisService(database, jobs);
  const controller = new AnalysisController(service);
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [Permission.ResearchRead],
    dataScope: "tenant",
  };
  const request: AuthenticatedRequest = { headers: {}, tenantContext: context };

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Report tenant', $2), ($3, 'Other report tenant', $4)`,
      [tenantId, `report-${tenantId}`, otherTenantId, `other-report-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Report User')`,
      [userId, `report-${userId}`, `${userId}@example.test`],
    );
    await withTenant(database.db, context, (tx) => tx.insert(analysisReports).values([
      row(report(1, "Initial finding")),
      row(report(2, "Updated finding")),
    ]));
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("queues a tenant-scoped analysis job", async () => {
    const receipt = await controller.create(request, {
      taskType: "AI-01",
      modelKey: "analyst.default",
      snapshotIds: [snapshotId],
      maxCostUsd: 1,
    });
    expect(receipt).toMatchObject({ status: "queued" });
    expect(enqueued).toMatchObject({ tenantId, requestedBy: userId });
    expect(enqueued?.payload).toMatchObject({ taskType: "AI-01", snapshotIds: [snapshotId] });
  });

  it("returns the latest report and ordered immutable versions", async () => {
    await expect(controller.latest(request, reportSeriesId)).resolves.toMatchObject({ version: 2, executiveSummary: "Updated finding" });
    const versions = await controller.versions(request, reportSeriesId);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
  });

  it("does not reveal reports across tenants", async () => {
    const otherRequest: AuthenticatedRequest = {
      headers: {},
      tenantContext: { ...context, tenantId: otherTenantId },
    };
    await expect(controller.latest(otherRequest, reportSeriesId)).rejects.toMatchObject({ status: 404 });
    await expect(controller.versions(otherRequest, reportSeriesId)).resolves.toEqual([]);
  });

  it("keeps report versions append-only for the application role", async () => {
    await expect(
      withTenant(database.db, context, (tx) =>
        tx.update(analysisReports).set({ version: 99 }).where(eq(analysisReports.reportSeriesId, reportSeriesId)),
      ),
    ).rejects.toThrow();
  });

  function report(version: number, executiveSummary: string): AnalysisReport {
    return {
      id: createEntityId(),
      reportSeriesId,
      version,
      taskType: "AI-01",
      status: "completed",
      title: "Market position",
      executiveSummary,
      sections: [{
        id: "pricing",
        title: "Pricing",
        claims: [{
          id: "price",
          kind: "fact",
          text: "The public price is $29.99.",
          evidence: [{ snapshotId, sourceType: "field", sourcePath: "price.amount", excerpt: "$29.99" }],
        }],
      }],
      inputSnapshotIds: [snapshotId],
      model: { providerId: "openai", modelKey: "analyst.default", costUsd: 0.03 },
      promptTemplateVersion: "analysis-v1",
      createdBy: userId,
      createdAt: new Date(Date.UTC(2026, 6, 18, version)).toISOString(),
    };
  }

  function row(value: AnalysisReport) {
    return {
      id: value.id,
      tenantId,
      reportSeriesId,
      version: value.version,
      taskType: value.taskType,
      status: value.status,
      inputSnapshotIds: value.inputSnapshotIds,
      report: value,
      createdBy: userId,
      createdAt: new Date(value.createdAt),
    };
  }
});
