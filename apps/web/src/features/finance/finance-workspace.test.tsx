import { createEntityId } from "@yummyai/contracts";
import type { FinanceWorkspaceView } from "@yummyai/contracts/finance";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FinanceWorkspace } from "./finance-workspace";

describe("FinanceWorkspace", () => {
  it("renders an explicit empty state without fabricated profit", () => {
    const html = renderToStaticMarkup(<FinanceWorkspace data={{
      statements: [],
      fxRates: [],
      metrics: [],
      runs: [],
    }} />);
    expect(html).toContain("还没有财务证据");
    expect(html).not.toContain("确认收入");
  });

  it("renders complete profit and incomplete diagnostics distinctly", () => {
    const metricId = createEntityId();
    const versionId = createEntityId();
    const statementId = createEntityId();
    const completeRun = run({
      metricId,
      metricVersionId: versionId,
      statementIds: [statementId],
      status: "complete",
      revenueMinor: 10_000,
      costMinor: 3_700,
      profitMinor: 6_300,
      marginBps: 6_300,
    });
    const incompleteRun = run({
      metricId,
      metricVersionId: versionId,
      statementIds: [statementId],
      status: "incomplete",
      revenueMinor: null,
      costMinor: null,
      profitMinor: null,
      marginBps: null,
      diagnostics: {
        missingFactTypes: ["production_cost"],
        missingFxPairs: ["EUR/USD"],
        unclassifiedFactTypes: [],
      },
    });
    const data: FinanceWorkspaceView = {
      statements: [{
        id: statementId,
        accountId: null,
        provider: "supplier",
        statementKind: "supplier_invoice",
        externalStatementId: "SUPPLIER-001",
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-07-31T23:59:59.000Z",
        sourceCurrency: "EUR",
        observedAt: "2026-08-01T00:00:00.000Z",
        recordedAt: "2026-08-01T00:00:01.000Z",
        checksum: "a".repeat(64),
        lines: [],
      }],
      fxRates: [],
      metrics: [{
        id: metricId,
        name: "Contribution margin",
        currentVersion: 1,
        status: "active",
        version: {
          id: versionId,
          metricId,
          versionNumber: 1,
          reportingCurrency: "USD",
          revenueFactTypes: ["sale_revenue"],
          costFactTypes: ["production_cost"],
          requiredFactTypes: ["sale_revenue", "production_cost"],
          reasonCode: "BASELINE",
          checksum: "b".repeat(64),
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }],
      runs: [completeRun, incompleteRun],
    };
    const html = renderToStaticMarkup(<FinanceWorkspace data={data} />);
    expect(html).toContain("USD 63.00");
    expect(html).toContain("63.00%");
    expect(html).toContain("缺事实 生产成本；缺汇率 EUR/USD");
    expect(html).toContain("缺失");
  });
});

function run(overrides: Partial<FinanceWorkspaceView["runs"][number]>): FinanceWorkspaceView["runs"][number] {
  return {
    id: createEntityId(),
    metricId: createEntityId(),
    metricVersionId: createEntityId(),
    metricVersion: 1,
    reportingCurrency: "USD",
    status: "complete",
    revenueMinor: 0,
    costMinor: 0,
    profitMinor: 0,
    marginBps: null,
    statementIds: [],
    fxRateIds: [],
    diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [] },
    inputChecksum: "c".repeat(64),
    calculatedAt: "2026-08-01T00:00:00.000Z",
    contributions: [],
    breakdowns: [],
    ...overrides,
  };
}
