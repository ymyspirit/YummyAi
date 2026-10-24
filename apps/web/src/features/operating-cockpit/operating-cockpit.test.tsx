import { createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import type { IntegrationApiClientView, IntegrationWorkspaceView } from "@yummyai/contracts/integration";
import type { PlanningWorkspaceView } from "@yummyai/contracts/planning";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OperatingCockpit } from "./operating-cockpit";
import { ErpIdentityContext } from "../identity/erp-access";
import { IntegrationClientRow } from "./integration-clients-panel";

const operator: ErpSessionView = {
  authenticated: true, canUseErp: true, userId: createEntityId(), tenantId: createEntityId(),
  displayName: "Synthetic integration operator", organizationName: "Synthetic organization",
  dataScope: "tenant", permissions: ["integration:read", "integration:manage", "inventory:read"],
  permissionScopes: { "integration:read": "tenant", "integration:manage": "tenant", "inventory:read": "team" },
  teamIds: [createEntityId()],
};
function renderCockpit(integration: IntegrationWorkspaceView | null, planning: PlanningWorkspaceView | null, session: ErpSessionView | null = operator) {
  return renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session, localDevelopment: false, logout: () => {} }}>
    <OperatingCockpit integration={integration} planning={planning} />
  </ErpIdentityContext.Provider>);
}

describe("OperatingCockpit", () => {
  it("renders an explicit unavailable state when neither workspace loaded", () => {
    const html = renderCockpit(null, null);
    expect(html).toContain("运营信号暂不可用");
  });

  it("keeps empty real workspaces distinct from unavailable data", () => {
    const html = renderCockpit(emptyIntegration(), emptyPlanning());
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

    const html = renderCockpit(integration, planning);
    expect(html).toContain("P10");
    expect(html).toContain("MAE 80");
    expect(html).toContain("不完整");
    expect(html).toContain("METRIC_INCOMPLETE");
    expect(html).toContain("死信");
    expect(html).toContain("V1");
  });

  it("clears stale integration props when the current actor or read permission differs", () => {
    const workspace = emptyIntegration();
    workspace.apiClients.push(client());
    for (const session of [null, { ...operator, userId: createEntityId() }, { ...operator, permissions: ["integration:manage"] }]) {
      const html = renderCockpit(workspace, emptyPlanning(), session);
      expect(html).not.toContain("Synthetic original client");
      expect(html).not.toContain(workspace.apiClients[0]!.keyPrefix);
      expect(html).not.toContain("创建只读客户端");
    }
  });

  it("keeps read-only catalog visibility distinct from client management and connectivity", () => {
    const reader: ErpSessionView = { ...operator, permissions: ["integration:read"], permissionScopes: { "integration:read": "self" } };
    const workspace = emptyIntegration(reader);
    workspace.clientAdmission.canManage = false;
    workspace.agentCatalog.capabilities.push({
      key: "orders.originals", version: "erp-agent-catalog-v1", domain: "orders", title: "订单原提交",
      effect: "prepare", minimumScope: "tenant", requiredPermissions: ["order:read", "order:write"],
      ownerState: "existing", agentState: "unauthorized", callableViaAgent: false,
    });
    const html = renderCockpit(workspace, emptyPlanning(), reader);
    expect(html).toContain("MCP 尚未连接");
    expect(html).toContain("当前没有可通过统一 Agent 调用的动作");
    expect(html).toContain("原业务拥有者已存在");
    expect(html).toContain("当前权限不足");
    expect(html).toContain("近期客户端 最多 100 条 不是完整历史");
    expect(html).not.toContain("创建只读客户端");
    expect(html).not.toContain("撤销客户端");
  });

  it("requires the server admission as well as the current manage bit", () => {
    const workspace = emptyIntegration(); workspace.clientAdmission.canManage = false;
    const html = renderCockpit(workspace, emptyPlanning());
    expect(html).not.toContain("创建只读客户端");
    expect(html).toContain("没有客户端创建或撤销权限");
  });

  it("shows original frozen scope and team without claiming a pinned credential is currently usable", () => {
    const original = client();
    const html = renderToStaticMarkup(<IntegrationClientRow client={original} />);
    expect(html).toContain("委派范围已固定");
    expect(html).toContain("固定团队");
    expect(html).toContain(operator.teamIds![0]!);
    expect(html).toContain(original.delegation!.requestChecksum);
    expect(html).toContain("已固定范围不代表当前调用一定可用");
    expect(html).toContain("当前仅可读取能力目录");
  });

  it("labels legacy missing delegation as requiring reissue and preserves revoked or expired status", () => {
    const original = client();
    const legacy = renderToStaticMarkup(<IntegrationClientRow client={{ ...original, delegation: null, credentialState: "requires_reissue" }} />);
    expect(legacy).toContain("历史记录没有委派快照 需重新签发");
    expect(legacy).not.toContain("委派范围已固定");
    for (const state of ["revoked", "expired"] as const) {
      const html = renderToStaticMarkup(<IntegrationClientRow client={{ ...original, credentialState: state }} />);
      expect(html).toContain(state === "revoked" ? "已撤销" : "已到期");
      expect(html).not.toContain("委派范围已固定");
    }
  });
});

function emptyPlanning(): PlanningWorkspaceView {
  return { forecasts: [], metricDefinitions: [], metricProjections: [], reconciliations: [], rebuilds: [] };
}

function emptyIntegration(session = operator): IntegrationWorkspaceView {
  const authority = erpSessionAuthority(session);
  return { contextAuthority: authority, clientAdmission: { scopes: [{ scope: "inventory:read", maximumScope: "team" }], teamIds: session.teamIds ?? [], canManage: true },
    agentCatalog: { contextAuthority: authority, version: "erp-agent-catalog-v1", mcpState: "not_connected", capabilities: [] },
    apiClients: [], webhookEndpoints: [], webhookEvents: [], webhookDeliveries: [], retentionRuns: [] };
}

function client(): IntegrationApiClientView {
  const id = createEntityId();
  return { id, label: "Synthetic original client", keyPrefix: `yai_${id}`, scopes: ["inventory:read"], status: "active", createdAt: stamp(1),
    expiresAt: null, revokedAt: null, credentialState: "pinned", delegation: { version: "integration-api-delegation-v1", membershipId: createEntityId(),
      capturedAt: stamp(1), requestChecksum: checksum("a"), permissionScopes: { "inventory:read": "team" }, teamIds: operator.teamIds ?? [] } };
}

function stamp(day: number, hour = 0) {
  return `2026-07-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

function checksum(character: string) {
  return character.repeat(64);
}
