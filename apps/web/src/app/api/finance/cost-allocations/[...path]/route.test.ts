import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FINANCE_COST_ALLOCATION_ALGORITHM, financeAllocatedProfitInputIdentity, financeCostPreviewChecksumIdentity,
  financeCostTargetBasisIdentity, financeCostVersionChecksumIdentity, splitFinanceCostMinor } from "@yummyai/contracts/finance/cost-allocation";
import { PersonalSessionError } from "../../../../../identity/core";
const upstream = vi.hoisted(() => vi.fn());
vi.mock("../../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";

const baseId = createEntityId(), rootId = createEntityId(), contributionId = createEntityId(), versionId = createEntityId(), allocationId = versionId,
  runId = createEntityId(), actorId = createEntityId(), statementId = createEntityId();
const hash = "a".repeat(64), at = "2026-07-03T00:00:00.000Z", prefix = "http://localhost:3130/api/finance/cost-allocations";
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
function target(key = "2026-07") {
  const value = { dimension: "period" as const, key, label: `Synthetic ${key} UTC period`, orderId: null, orderLineId: null, skuId: null, listingId: null,
    accountId: null, spuId: null, catalogLinkId: null, period: key, periodStart: `${key}-01T00:00:00.000Z`, periodEnd: key === "2026-07" ? "2026-08-01T00:00:00.000Z" : "2026-09-01T00:00:00.000Z", basisChecksum: hash };
  return { ...value, basisChecksum: digest(financeCostTargetBasisIdentity(value)) };
}
const input = () => ({ baseRunId: baseId, baseInputChecksum: hash, allocationId: null, expectedVersion: null, dimension: "period" as const, method: "equal" as const,
  sources: [{ rootFactId: rootId, targets: [{ key: "2026-07", weight: "1" }, { key: "2026-08", weight: "1" }] }], reasonCode: "SYNTHETIC", basisDescription: "Synthetic original operator allocation basis" });
function preview() {
  const value = { ...input(), algorithm: FINANCE_COST_ALLOCATION_ALGORITHM, reportingCurrency: "USD", sources: [{ rootFactId: rootId, contributionId, factId: rootId,
    statementId, statementChecksum: hash, sourceEntryId: "synthetic:original:cost", factType: "carrier_cost" as const, effectSign: 1 as const,
    sourceCurrency: "USD", sourceAmountMinor: 101, reportingCurrency: "USD", reportingAmountMinor: 101, fxRateId: null, sourceChainChecksum: hash,
    shares: splitFinanceCostMinor(101, input().sources[0]!.targets).map(({ key, ...share }) => ({ ...share, target: target(key) })) }], previewChecksum: hash };
  return { ...value, previewChecksum: digest(financeCostPreviewChecksumIdentity(value)) };
}
function version(value = preview()) {
  const result = { id: versionId, allocationId, versionNumber: 1, previousVersionId: null, status: "approved" as const, preview: value, checksum: hash, reviewedBy: actorId, createdAt: at, basisProblems: [] };
  return { ...result, checksum: digest(financeCostVersionChecksumIdentity(result)) };
}
function run() {
  const value = { id: runId, baseRunId: baseId, baseInputChecksum: hash, dimension: "period" as const, versionPins: [{ id: versionId, allocationId, versionNumber: 1, checksum: version().checksum }],
    algorithm: FINANCE_COST_ALLOCATION_ALGORITHM, reportingCurrency: "USD", status: "complete" as const, revenueMinor: 1000, costMinor: 101, profitMinor: 899, marginBps: 8990,
    diagnostics: { unallocatedContributionIds: [], checkedTargetCount: 2, missingByTarget: [] }, breakdowns: [
      { target: target(), revenueMinor: 500, costMinor: 51, profitMinor: 449, factCount: 2 }, { target: target("2026-08"), revenueMinor: 500, costMinor: 50, profitMinor: 450, factCount: 2 }],
    inputChecksum: hash, createdAt: at, basisProblems: [] };
  return { ...value, inputChecksum: digest(financeAllocatedProfitInputIdentity(value)) };
}
const calculate = () => ({ baseRunId: baseId, baseInputChecksum: hash, dimension: "period", versionIds: [versionId], idempotencyKey: "synthetic-original-projection" });
const request = (path: string, body?: unknown, origin = "http://localhost:3130") => new Request(`${prefix}/${path}`, body === undefined ? {}
  : { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
const page = (items: unknown[], upperBoundKey: string | null, limit = 25) => ({ items, upperBoundKey, limit, order: "id_desc", consistency: "live", hasMore: false, nextCursor: null });
const cursor = (upperKey: string, key: string, scope = hash) => Buffer.from(JSON.stringify({ v: 1, scope, upperKey, key })).toString("base64url");
const summary = (id: string) => ({ id, allocationId: id, versionNumber: 1, baseRunId: baseId, dimension: "period", reportingCurrency: "USD", sourceCount: 1, checksum: hash, createdAt: at });
beforeEach(() => { upstream.mockReset(); vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130"); });
afterEach(() => vi.unstubAllEnvs());

describe("personal cost-attribution proxy preserves original evidence and strict request identity", () => {
  it("previews without mutating or replacing the original body and returns only one authenticated 200 response", async () => {
    const value = preview(); upstream.mockResolvedValue(Response.json(value));
    const response = await POST(request("preview", input()), context("preview")); expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
    expect(upstream).toHaveBeenCalledOnce(); const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8130/v1/finance/cost-allocations/preview"); expect(init.method).toBe("POST"); expect(init.cache).toBe("no-store");
    expect(JSON.parse(init.body)).toEqual(input()); expect(new Headers(init.headers).has("x-tenant-id")).toBe(false); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each(["versions", "runs"] as const)("forwards a single %s write with its original key and validates its actual 201 receipt", async path => {
    const actualPreview = preview(), body = path === "versions" ? { ...input(), previewChecksum: actualPreview.previewChecksum, idempotencyKey: "synthetic-original-approval" } : calculate();
    const value = path === "versions" ? version(actualPreview) : run(); upstream.mockResolvedValue(Response.json(value, { status: 201 }));
    const response = await POST(request(path, body), context(path)); expect(response.status).toBe(201); expect(await response.json()).toEqual(value);
    expect(JSON.parse(upstream.mock.calls[0]![1].body)).toEqual(body); expect(upstream).toHaveBeenCalledOnce();
  });
  it("rejects cross-origin writes, caller-selected authority and invalid typed target overrides before upstream I/O", async () => {
    expect((await POST(request("preview", input(), "https://elsewhere.test"), context("preview"))).status).toBe(403);
    for (const body of [null, { ...input(), tenantId: baseId }, { ...input(), approved: true }, { ...input(), sources: [{ rootFactId: rootId, targets: [{ key: "2026-07", weight: "1", orderId: rootId }] }] }])
      expect((await POST(request("preview", body), context("preview"))).status).toBe(400);
    for (const query of ["limit=1", "limit=1&limit=1"]) expect((await POST(request(`preview?${query}`, input()), context("preview"))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects unsupported actions and methods instead of routing arbitrary finance operations", async () => {
    expect((await POST(request("runs/invalid/cancel", {}), context("runs", "invalid", "cancel"))).status).toBe(404);
    expect((await GET(request("preview"), context("preview"))).status).toBe(404);
    expect((await GET(request("targets/extra"), context("targets", "extra"))).status).toBe(404); expect(upstream).not.toHaveBeenCalled();
  });
  it("requires JSON and enforces the actual 256 KiB body limit before parsing or making a write", async () => {
    for (const type of ["text/plain", "application/jsonish"]) {
      const invalidType = new Request(`${prefix}/preview`, { method: "POST", headers: { origin: "http://localhost:3130", "content-type": type }, body: JSON.stringify(input()) });
      expect((await POST(invalidType, context("preview"))).status).toBe(415);
    }
    const oversized = new Request(`${prefix}/preview`, { method: "POST", headers: { origin: "http://localhost:3130", "content-type": "application/json" }, body: " ".repeat(262_145) });
    expect((await POST(oversized, context("preview"))).status).toBe(413); expect(upstream).not.toHaveBeenCalled();
  });
  it("forwards an explicit UTC month target query with a real non-UUID upper bound", async () => {
    const value = page([target()], "2026-07"); upstream.mockResolvedValue(Response.json(value));
    const response = await GET(request("targets?dimension=period&key=2026-07"), context("targets")); expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
    const url = new URL(upstream.mock.calls[0]![0]); expect(url.pathname).toBe("/v1/finance/cost-allocations/targets");
    expect(Object.fromEntries(url.searchParams)).toEqual({ dimension: "period", key: "2026-07", limit: "25" });
  });
  it.each(["?dimension=period", "?dimension=order&key=2026-07", "?dimension=period&key=2026-07&limit=1&limit=1",
    "?dimension=order&tenantId=caller", "?dimension=order&offset=25"])("rejects an absent, wrong or duplicated target query %s", async query => {
    expect((await GET(request(`targets${query}`), context("targets"))).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  });
  it("refuses body/query attempts to replace route-bound base, run and detail identities", async () => {
    for (const [path, query] of [[`bases/${baseId}/sources`, `baseRunId=${rootId}&dimension=period`], [`runs/${runId}/slices`, `runId=${rootId}`], [`versions/${versionId}`, "limit=1"]])
      expect((await GET(request(`${path}?${query}`), context(...path!.split("/")))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects noncanonical cursor bytes, duplicate JSON keys and unknown cursor envelopes before upstream reads", async () => {
    const [low, high] = [createEntityId(), createEntityId()].sort();
    const variants = ["not-a-cursor", Buffer.from(`{"v":1, "scope":"${hash}","upperKey":"${high}","key":"${low}"}`).toString("base64url"),
      Buffer.from(`{"v":1,"v":1,"scope":"${hash}","upperKey":"${high}","key":"${low}"}`).toString("base64url"),
      Buffer.from(JSON.stringify({ scope: hash, v: 1, upperKey: high, key: low })).toString("base64url"), cursor(low!, high!)];
    for (const raw of variants) expect((await GET(request(`versions?cursor=${raw}`), context("versions"))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("checks first-page descending order and continuation anchors instead of accepting a schema-valid unrelated next cursor", async () => {
    const [low, middle, high] = [createEntityId(), createEntityId(), createEntityId()].sort();
    const valid = { ...page([summary(high!), summary(middle!)], high!, 2), hasMore: true, nextCursor: cursor(high!, middle!) };
    upstream.mockResolvedValueOnce(Response.json(valid)); expect((await GET(request("versions?limit=2"), context("versions"))).status).toBe(200);
    for (const changed of [{ ...valid, upperBoundKey: middle }, { ...valid, items: [...valid.items].reverse() },
      { ...valid, items: [summary(high!), summary(high!)] }, { ...valid, nextCursor: cursor(high!, low!) }, { ...valid, nextCursor: cursor(middle!, middle!) }]) {
      upstream.mockResolvedValueOnce(Response.json(changed)); expect((await GET(request("versions?limit=2"), context("versions"))).status).toBe(502);
    }
  });
  it("binds a later page to the requested upper key, strict previous position and next scope without claiming cursor authority", async () => {
    const [low, middle, high] = [createEntityId(), createEntityId(), createEntityId()].sort(), requested = cursor(high!, middle!);
    const valid = page([summary(low!)], high!, 1);
    upstream.mockResolvedValueOnce(Response.json(valid)); expect((await GET(request(`versions?limit=1&cursor=${requested}`), context("versions"))).status).toBe(200);
    for (const changed of [{ ...valid, upperBoundKey: low }, { ...valid, items: [summary(middle!)] },
      { ...valid, hasMore: true, nextCursor: cursor(high!, low!, "b".repeat(64)) },
      { ...valid, hasMore: true, nextCursor: cursor(middle!, low!) }]) {
      upstream.mockResolvedValueOnce(Response.json(changed)); expect((await GET(request(`versions?limit=1&cursor=${requested}`), context("versions"))).status).toBe(502);
    }
  });
  it("checks real target identity and its canonical basis checksum even when a page has the expected key and shape", async () => {
    const original = target();
    for (const changed of [{ ...original, basisChecksum: "b".repeat(64) }, { ...target("2026-08") }]) {
      upstream.mockResolvedValueOnce(Response.json(page([changed], changed.key)));
      expect((await GET(request("targets?dimension=period&key=2026-07"), context("targets"))).status).toBe(502);
    }
  });
  it("refuses schema-valid version rows that do not belong to the requested original base or allocation filter", async () => {
    const original = summary(versionId);
    for (const changed of [{ ...original, baseRunId: rootId }, { ...original, allocationId: rootId }]) {
      upstream.mockResolvedValueOnce(Response.json(page([changed], versionId)));
      expect((await GET(request(`versions?baseRunId=${baseId}&allocationId=${allocationId}`), context("versions"))).status).toBe(502);
    }
  });
  it("rejects over-8 MiB upstream JSON before exposing any partial financial response", async () => {
    upstream.mockResolvedValue(new Response(" ".repeat(8 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }));
    const response = await GET(request("targets?dimension=period&key=2026-07"), context("targets")); expect(response.status).toBe(502); expect(upstream).toHaveBeenCalledOnce();
  });
  it("does not repair invalid UTF-8 in the original JSON request or a private response", async () => {
    const bad = new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]);
    const response = await POST(new Request(`${prefix}/preview`, { method: "POST", headers: { origin: "http://localhost:3130", "content-type": "application/json" }, body: bad }), context("preview"));
    expect(response.status).toBe(400); expect(upstream).not.toHaveBeenCalled();
    upstream.mockResolvedValueOnce(new Response(bad, { headers: { "content-type": "application/json" } }));
    expect((await GET(request("versions"), context("versions"))).status).toBe(502);
  });
  it.each([[401, "login_required"], [403, "erp_access_denied"], [409, "authority_changed"]] as const)("preserves session failure %i and its authority boundary instead of masking it as provider success", async (status, code) => {
    upstream.mockRejectedValue(new PersonalSessionError(status, code)); const response = await POST(request("preview", input()), context("preview"));
    expect(response.status).toBe(status); const value = await response.json();
    if (code === "authority_changed") expect(value.code).toBe("authority_changed"); expect(upstream).toHaveBeenCalledOnce();
  });
  it.each([400, 401, 403, 404, 409, 422])("preserves public status %i without exposing private backend messages or fabricating success", async status => {
    upstream.mockResolvedValue(Response.json({ code: "finance_cost_allocation_version_changed", message: "SYNTHETIC-PRIVATE-TOKEN", internal: "not-public" }, { status }));
    const response = await POST(request("preview", input()), context("preview")); expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("SYNTHETIC-PRIVATE"); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("rejects a preview for another base, checksum, root, target or recorded rule basis", async () => {
    const original = preview();
    for (const changed of [{ ...original, baseRunId: rootId }, { ...original, baseInputChecksum: "b".repeat(64) }, { ...original, basisDescription: "Other original basis" },
      { ...original, sources: [{ ...original.sources[0]!, rootFactId: contributionId }] }, { ...original, method: "manual_weights" }]) {
      upstream.mockResolvedValueOnce(Response.json(changed)); expect((await POST(request("preview", input()), context("preview"))).status).toBe(502);
    }
  });
  it("rejects an approval receipt whose stored original preview or optimistic predecessor disagrees with the submitted decision", async () => {
    const original = preview(), body = { ...input(), previewChecksum: original.previewChecksum, idempotencyKey: "synthetic-original-approval" }, result = version(original);
    for (const changed of [{ ...result, preview: { ...original, baseRunId: rootId } }, { ...result, preview: { ...original, previewChecksum: "b".repeat(64) } },
      { ...result, versionNumber: 2, previousVersionId: rootId }]) {
      upstream.mockResolvedValueOnce(Response.json(changed, { status: 201 })); expect((await POST(request("versions", body), context("versions"))).status).toBe(502);
    }
  });
  it("rejects a projected result using another original base, dimension or selected version set", async () => {
    const original = run();
    for (const changed of [{ ...original, baseRunId: rootId }, { ...original, baseInputChecksum: "b".repeat(64) }, { ...original, versionPins: [] }]) {
      upstream.mockResolvedValueOnce(Response.json(changed, { status: 201 })); expect((await POST(request("runs", calculate()), context("runs"))).status).toBe(502);
    }
  });
  it("rejects valid detail or slices belonging to a different actual version/run ID", async () => {
    upstream.mockResolvedValueOnce(Response.json({ ...version(), id: rootId }));
    expect((await GET(request(`versions/${versionId}`), context("versions", versionId))).status).toBe(502);
    upstream.mockResolvedValueOnce(Response.json({ ...run(), id: rootId }));
    expect((await GET(request(`runs/${runId}`), context("runs", runId))).status).toBe(502);
    const slice = { id: createEntityId(), runId: rootId, baseContributionId: contributionId, sourceFactId: rootId, rootFactId: rootId, allocationVersionId: versionId,
      target: target(), amountMinor: 51, originalReportingAmountMinor: 101, bucket: "cost", effectSign: 1, factType: "carrier_cost", weight: "1", floorMinor: 50,
      remainderNumerator: "1000000000", remainderDenominator: "2000000000", receivesRemainder: true, createdAt: at };
    upstream.mockResolvedValueOnce(Response.json(page([slice], slice.id)));
    expect((await GET(request(`runs/${runId}/slices`), context("runs", runId, "slices"))).status).toBe(502);
  });
  it("does not retry a transport error or expose its thrown text as a model, credential or query diagnostic", async () => {
    upstream.mockRejectedValue(new Error("SYNTHETIC-PRIVATE-PROVIDER-SECRET")); const response = await POST(request("preview", input()), context("preview"));
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("SYNTHETIC-PRIVATE"); expect(upstream).toHaveBeenCalledOnce();
  });
});
