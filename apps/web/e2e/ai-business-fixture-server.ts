// Isolated browser transport only: no writes, no provider calls, no test records in the user tenant.
import { createServer } from "node:http";
import { FinanceWorkspaceViewSchema } from "@yummyai/contracts/finance";
import { ProcurementWorkspaceViewSchema } from "@yummyai/contracts/procurement";
const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-14T00:00:00.000Z";
const finance = FinanceWorkspaceViewSchema.parse({
  statements: [
    {
      id: id(203),
      accountId: null,
      provider: "manual",
      statementKind: "manual_adjustment",
      externalStatementId: "SYNTHETIC-BROWSER-ONLY",
      periodStart: now,
      periodEnd: now,
      sourceCurrency: "USD",
      observedAt: now,
      recordedAt: now,
      checksum: "a".repeat(64),
      lines: [],
    },
  ],
  fxRates: [],
  metrics: [],
  runs: [201, 202].map((n) => ({
    id: id(n),
    metricId: id(204),
    metricVersionId: id(205),
    metricVersion: 1,
    reportingCurrency: "USD",
    status: n === 201 ? "incomplete" : "complete",
    revenueMinor: n === 201 ? null : 7350,
    costMinor: n === 201 ? null : 2100,
    profitMinor: n === 201 ? null : 5250,
    marginBps: n === 201 ? null : 7143,
    statementIds: [id(203)],
    fxRateIds: [],
    diagnostics: {
      missingFactTypes: n === 201 ? ["production_cost"] : [],
      missingFxPairs: [],
      unclassifiedFactTypes: [],
    },
    inputChecksum: "a".repeat(64),
    calculatedAt: now,
    contributions: [],
    breakdowns: [],
  })),
});
const procurement = ProcurementWorkspaceViewSchema.parse({
  suppliers: [],
  stockItems: [
    {
      id: id(211),
      code: "SYNTHETIC-BLANK",
      name: "合成测试坯品",
      baseUnit: "each",
      status: "active",
    },
  ],
  locations: [{ id: id(212), code: "SYNTHETIC-DOCK", name: "合成测试库位", status: "active" }],
  requisitions: [],
  rfqs: [],
  quotes: [],
  purchaseOrders: [],
  receipts: [],
  invoices: [],
  policies: [],
  suggestions: [],
});
const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("Fixture blocks writes");
      return;
    }
    const path = request.url ?? "/";
    const value =
      path === "/health"
        ? { ok: true }
        : path === "/v1/finance/workspace"
          ? finance
          : path === "/v1/procurement/workspace"
            ? procurement
            : null;
    if (value) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
      return;
    }
    // Same-machine authenticated ERP reads provide the real shell. Never forward to an arbitrary host.
    const destination = new URL(path, "http://127.0.0.1:8000");
    if (destination.origin !== "http://127.0.0.1:8000") {
      response.writeHead(400);
      response.end("Invalid fixture path");
      return;
    }
    const result = await fetch(destination, {
      headers:
        typeof request.headers.authorization === "string"
          ? { authorization: request.headers.authorization }
          : {},
      redirect: "error",
    });
    response.writeHead(result.status, {
      "content-type": result.headers.get("content-type") ?? "application/json",
    });
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(502);
    response.end("Fixture unavailable");
  }
});
server.listen(3311, "127.0.0.1");
