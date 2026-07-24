import { createEntityId } from "@yummyai/contracts";
import type { IntegrationWorkspaceView } from "@yummyai/contracts/integration";
import type { PlanningWorkspaceView } from "@yummyai/contracts/planning";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OperatingCockpit } from "./operating-cockpit";

describe("OperatingCockpit", () => {
  it("renders an explicit unavailable state when neither workspace loaded", () => {
    const html = renderToStaticMarkup(<OperatingCockpit integration={null} planning={null} />);
    expect(html).toContain("运营信号暂不可用");
  });

  it("keeps empty real workspaces distinct from unavailable data", () => {
    const html = renderToStaticMarkup(
      <OperatingCockpit integration={emptyIntegration()} planning={emptyPlanning()} />,
    );
    expect(html).toContain("还没有预测运行");
    expect(html).toContain("还没有 API 客户端或 Webhook 端点");
    expect(html).not.toContain("规划工作区不可用");
  });

  it("shows pinned forecast, metric gaps, reconciliation, and signed delivery evidence", () => {
    const planning = emptyPlanning();
    const integration = emptyIntegration();
    const runId = createEntityId();
    const definitionId = createEntityId();
    const snapshotId = createEntityId();
    const endpointId = createEntityId();
    const eventId = createEntityId();
    planning.forecasts.push({
      id: runId,
      metric: "profit_minor",
      scopeType: "tenant",
      scopeKey: "tenant-a",
      grain: "day",
      model: "moving_average_v1",
      modelVersion: "2026.07.1",
      inputWindowStart: stamp(1),
      inputWindowEnd: stamp(3),
      evidenceCutoffAt: stamp(3, 1),
      horizonStart: stamp(3),
      horizonEnd: stamp(5),
      quantilesBps: [1_000, 5_000, 9_000],
      inputPoints: [
        { periodStart: stamp(1), value: 1_000, evidenceRefs: [{ sourceType: "profit_run", sourceId: createEntityId() }] },
        { periodStart: stamp(2), value: 1_200, evidenceRefs: [{ sourceType: "profit_run", sourceId: createEntityId() }] },
      ],
      inputChecksum: checksum("a"),
      generatedAt: stamp(3, 2),
      points: [{ id: createEntityId(), periodStart: stamp(3), values: [{ quantileBps: 1_000, value: 900 }, { quantileBps: 5_000, value: 1_100 }, { quantileBps: 9_000, value: 1_300 }] }],
      accuracy: [{ id: createEntityId(), evaluationWindowStart: stamp(3), evaluationWindowEnd: stamp(5), actualEvidenceRefs: [{ sourceType: "profit_run", sourceId: createEntityId() }], meanAbsoluteError: 80, weightedAbsolutePercentageErrorBps: 625, biasBps: -120, inputChecksum: checksum("b"), evaluatedAt: stamp(6) }],
      overrides: [{ id: createEntityId(), versionNumber: 1, reasonCode: "OPS_REVIEW", points: [{ periodStart: stamp(3), medianValue: 1_150 }], checksum: checksum("c"), createdAt: stamp(4) }],
    });
    planning.metricDefinitions.push({
      id: definitionId,
      key: "forecast.profit.p50",
      name: "利润预测中位数",
      currentVersion: 1,
      status: "active",
      version: { id: createEntityId(), versionNumber: 1, unit: "minor", source: "forecast", maximumAgeSeconds: 3_600, minimumCompletenessBps: 9_500, reasonCode: "P3_COCKPIT", checksum: checksum("d"), createdAt: stamp(1) },
      createdAt: stamp(1),
      updatedAt: stamp(1),
    });
    planning.metricProjections.push({ definitionId, snapshot: { id: snapshotId, definitionId, definitionVersionId: planning.metricDefinitions[0]!.version.id, definitionVersion: 1, value: 1_100, observedAt: stamp(3), recordedAt: stamp(3, 1), completenessBps: 9_000, sourceRefs: [{ sourceType: "forecast_run", sourceId: runId }], drillThroughHref: "/finance", checksum: checksum("e"), state: "incomplete", ageSeconds: 7_200 } });
    planning.reconciliations.push({ id: createEntityId(), category: "completeness", code: "METRIC_INCOMPLETE", status: "open", metricSnapshotId: snapshotId, sourceRef: null, detailChecksum: checksum("f"), openedAt: stamp(3, 1), resolvedAt: null });

    integration.webhookEndpoints.push({ id: endpointId, label: "ERP sink", url: "https://example.test/hooks", eventTypes: ["forecast.completed"], maxAttempts: 3, status: "active", version: 1, signingKeyPrefix: "whsec_example", createdAt: stamp(1), updatedAt: stamp(1) });
    integration.webhookEvents.push({ id: eventId, eventType: "forecast.completed", resourceType: "forecast_run", resourceId: runId, payloadChecksum: checksum("1"), payloadAvailable: true, occurredAt: stamp(3), recordedAt: stamp(3) });
    integration.webhookDeliveries.push({ id: createEntityId(), eventId, endpointId, status: "dead_letter", attemptCount: 3, maxAttempts: 3, nextAttemptAt: null, replayOfDeliveryId: null, createdAt: stamp(3), completedAt: stamp(3, 2), attempts: [{ id: createEntityId(), attemptNumber: 3, requestTimestamp: stamp(3, 1), signatureVersion: "v1", responseStatus: 500, outcome: "retryable_failure", failureCode: "HTTP_500", completedAt: stamp(3, 2) }] });

    const html = renderToStaticMarkup(
      <OperatingCockpit integration={integration} planning={planning} />,
    );
    expect(html).toContain("P10");
    expect(html).toContain("MAE 80");
    expect(html).toContain("不完整");
    expect(html).toContain("METRIC_INCOMPLETE");
    expect(html).toContain("死信");
    expect(html).toContain("V1");
  });
});

function emptyPlanning(): PlanningWorkspaceView {
  return { forecasts: [], metricDefinitions: [], metricProjections: [], reconciliations: [], rebuilds: [] };
}

function emptyIntegration(): IntegrationWorkspaceView {
  return { apiClients: [], webhookEndpoints: [], webhookEvents: [], webhookDeliveries: [], retentionRuns: [] };
}

function stamp(day: number, hour = 0) {
  return `2026-07-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

function checksum(character: string) {
  return character.repeat(64);
}
