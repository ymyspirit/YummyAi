import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { ProductionQuantityWorkspaceSchema, ProductionQuantityReportResultSchema, ProductionQuantityReviewResultSchema,
  type ProductionQuantityReportInput, type ProductionQuantityReviewInput } from "@yummyai/contracts/order/production-quantity";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn(), identity: vi.fn(), current: vi.fn(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const productionId = createEntityId(), versionId = createEntityId(), actorId = createEntityId(), orderId = createEntityId(), lineId = createEntityId();
const reportId = "019f0000-0000-7000-8000-000000000010", earlierId = "019f0000-0000-7000-8000-000000000009", reviewId = createEntityId();
const context: TenantContext = { tenantId: createEntityId(), userId: actorId, permissions: ["order:read", "order:write"], dataScope: "tenant" };
const origin = "http://localhost:3130", at = "2026-10-21T00:00:00.000Z", fingerprint = "a".repeat(64);
const authority = () => ({ contextAuthority: erpSessionAuthority(context), access: { canRead: true as const, canWrite: true } });
const reportInput = (): ProductionQuantityReportInput => ({ idempotencyKey: "synthetic-exact-report-key", productionVersionId: versionId,
  expectedProductionProjectionVersion: 1, expectedReviewId: null, expectedBasisFingerprint: fingerprint, observedAt: at,
  quantities: { unstartedQuantity: 2, inProcessQuantity: 1, completedQuantity: 2, scrappedQuantity: 0 }, evidenceCode: "SYNTHETIC_COUNT", evidenceAssetIds: [] });
const reviewInput = (): ProductionQuantityReviewInput => ({ idempotencyKey: "synthetic-exact-review-key", reportId,
  expectedProductionProjectionVersion: 1, expectedReviewId: null, expectedBasisFingerprint: fingerprint,
  stoppedDelta: 2, unstartedAcrossAllPoolsConfirmed: true, evidenceCode: "SYNTHETIC_STOP", occurredAt: at });
const report = () => ({ id: reportId, productionOrderId: productionId, productionVersionId: versionId, input: reportInput(),
  previousReviewId: null, basisFingerprint: fingerprint, createdBy: actorId, createdAt: at });
const review = () => ({ id: reviewId, productionOrderId: productionId, productionVersionId: versionId, reportId, sequence: 1, previousReviewId: null,
  input: reviewInput(), cumulativeStoppedQuantity: 2, quantities: { unstartedQuantity: 0, inProcessQuantity: 1, completedQuantity: 2, scrappedQuantity: 0 }, createdBy: actorId, createdAt: at });
const workspace = () => ProductionQuantityWorkspaceSchema.parse({ ...authority(), basis: { productionOrderId: productionId, orderId, orderLineId: lineId,
  productionVersionId: versionId, projectionVersion: 1, status: "in_production", quantity: 5, factoryId: createEntityId(), manufacturingBindingId: createEntityId(), manufacturingVersionId: createEntityId(), unit: "each",
  reviewId: null, cumulativeStoppedQuantity: 0, currentQuantities: null, groupedQuantity: 2, groupedPassedQuantity: 1, allocatedQuantity: 2, shippedQuantity: 1,
  completedLowerBound: 2, unknownShipmentSource: false, capacityStatus: "reserved", reservations: [{ reservationId: createEntityId(), poolId: createEntityId(), poolVersionId: createEntityId(),
    localDate: "2026-10-21", unit: "minute", unitsPerItem: 2, totalUnits: 10, grossCommittedUnits: 10, grossReleasedUnits: 0, stopReleasedUnits: 0, stopCommitReductionUnits: 0 }], blockers: [], fingerprint },
  reports: [report()], reviews: [], reportsNextCursor: null, reviewsNextCursor: null });
const reportResult = () => ProductionQuantityReportResultSchema.parse({ ...authority(), report: report(), replayed: false });
const reviewResult = () => ProductionQuantityReviewResultSchema.parse({ ...authority(), review: review(), replayed: false });
const path = (...segments: string[]) => ({ params: Promise.resolve({ path: segments }) });
const route = (action?: "reports" | "reviews") => path("orders", productionId, "quantity", ...(action ? [action] : []));
const get = (query = "") => new Request(`${origin}/api/production-quantity/orders/${productionId}/quantity${query}`);
const post = (action: "reports" | "reviews", body: unknown, requestOrigin = origin, contentType = "application/json") => new Request(`${origin}/api/production-quantity/orders/${productionId}/quantity/${action}`, {
  method: "POST", headers: { origin: requestOrigin, "content-type": contentType }, body: JSON.stringify(body),
});
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("API_BASE_URL", "http://127.0.0.1:29000/"); mocks.identity.mockReset().mockResolvedValue({ view: context });
  mocks.current.mockReset().mockResolvedValue(undefined); mocks.upstream.mockReset();
  mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); });
afterEach(() => vi.unstubAllEnvs());

describe("production quantity personal BFF preserves actual counts and original requests", () => {
  it("reads the exact authorized production with private headers and no caller-selected identity", async () => {
    const view = workspace(); mocks.upstream.mockResolvedValueOnce(Response.json(view)); const response = await GET(get(), route());
    expect(response.status).toBe(200); expect(await response.json()).toEqual(view); expect(mocks.identity).toHaveBeenCalledOnce(); expect(mocks.current).toHaveBeenCalledTimes(2);
    const [url, init] = mocks.upstream.mock.calls[0]!; expect(url).toBe(`http://127.0.0.1:29000/v1/production/orders/${productionId}/quantity?limit=20`);
    expect(init.cache).toBe("no-store"); expect(init.redirect).toBe("error"); expect(new Headers(init.headers).has("authorization")).toBe(false); expect(new Headers(init.headers).has("x-tenant-id")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("posts a complete report with its original key and keeps unknown counts null", async () => {
    const input = { ...reportInput(), quantities: { ...reportInput().quantities, completedQuantity: null } }, result = { ...reportResult(), report: { ...report(), input } };
    mocks.upstream.mockResolvedValueOnce(Response.json(result, { status: 201 })); const response = await POST(post("reports", input), route("reports"));
    expect(response.status).toBe(201); expect(await response.json()).toEqual(result); expect(JSON.parse(mocks.upstream.mock.calls[0]![1].body)).toEqual(input);
    expect(mocks.current).toHaveBeenCalledTimes(2);
  });
  it("returns the exact immutable review receipt instead of a fabricated current workspace", async () => {
    const result = reviewResult(); mocks.upstream.mockResolvedValueOnce(Response.json(result, { status: 201 })); const response = await POST(post("reviews", reviewInput()), route("reviews"));
    expect(response.status).toBe(201); expect(await response.json()).toEqual(result); expect(JSON.parse(mocks.upstream.mock.calls[0]![1].body)).toEqual(reviewInput());
  });
  it("allows an explicit zero-delta review without inventing an all-pools confirmation", async () => {
    const input = { ...reviewInput(), stoppedDelta: 0, unstartedAcrossAllPoolsConfirmed: false }, result = { ...reviewResult(), review: { ...review(), input, cumulativeStoppedQuantity: 0, quantities: reportInput().quantities } };
    mocks.upstream.mockResolvedValueOnce(Response.json(result, { status: 201 })); expect((await POST(post("reviews", input), route("reviews"))).status).toBe(201);
    expect(JSON.parse(mocks.upstream.mock.calls[0]![1].body)).toEqual(input);
  });
  it("rejects positive stopping without the explicit all-pools evidence", async () => {
    expect((await POST(post("reviews", { ...reviewInput(), unstartedAcrossAllPoolsConfirmed: false }), route("reviews"))).status).toBe(400); expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it.each(["?tenantId=caller", "?limit=20&limit=20", "?reportsBefore=wrong", "?limit=51"])("rejects ambiguous or unsupported query %s", async query => {
    expect((await GET(get(query), route())).status).toBe(400); expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("rejects invalid routes and write query injection before upstream I/O", async () => {
    expect((await GET(get(), path("orders", "not-an-id", "quantity"))).status).toBe(404);
    expect((await GET(get(), path("orders", productionId, "quantity", "reviews"))).status).toBe(404);
    const request = new Request(`${origin}/api/production-quantity/orders/${productionId}/quantity/reports?limit=1`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(reportInput()) });
    expect((await POST(request, route("reports"))).status).toBe(400); expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("requires same origin, JSON and the complete bounded write body", async () => {
    expect((await POST(post("reports", reportInput(), "https://invalid.example"), route("reports"))).status).toBe(403);
    expect((await POST(post("reports", reportInput(), origin, "text/plain"), route("reports"))).status).toBe(415);
    expect((await POST(post("reports", { ...reportInput(), evidenceCode: "X".repeat(263_000) }), route("reports"))).status).toBe(413);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("rejects missing personal identity without falling back to a service account", async () => {
    mocks.identity.mockRejectedValueOnce(new PersonalSessionError(401, "login_required")); expect((await GET(get(), route())).status).toBe(401); expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("requires tenant Read and keeps tenant Write separate from a self-scoped permission", async () => {
    const readSelf: TenantContext = { ...context, permissionScopes: { "order:read": "self", "order:write": "tenant" } };
    mocks.identity.mockResolvedValueOnce({ view: readSelf }); expect((await GET(get(), route())).status).toBe(403); expect(mocks.upstream).not.toHaveBeenCalled();
    const writeSelf: TenantContext = { ...context, permissionScopes: { "order:read": "tenant", "order:write": "self" } };
    mocks.identity.mockResolvedValueOnce({ view: writeSelf }); expect((await POST(post("reports", reportInput()), route("reports"))).status).toBe(403); expect(mocks.upstream).not.toHaveBeenCalled();
    const view = { ...workspace(), contextAuthority: erpSessionAuthority(writeSelf), access: { canRead: true, canWrite: false } };
    mocks.identity.mockResolvedValueOnce({ view: writeSelf }); mocks.upstream.mockResolvedValueOnce(Response.json(view)); expect((await GET(get(), route())).status).toBe(200);
  });
  it("rejects a changed identity after upstream I/O", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json(workspace())); mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const response = await GET(get(), route()); expect(response.status).toBe(409); expect((await response.json()).code).toBe("authority_changed");
  });
  it("rejects a valid stamped response belonging to another current authority", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...reportResult(), contextAuthority: erpSessionAuthority({ ...context, permissions: ["order:read"] }), access: { canRead: true, canWrite: false } }, { status: 201 }));
    const response = await POST(post("reports", reportInput()), route("reports")); expect(response.status).toBe(409); expect((await response.json()).code).toBe("authority_changed");
  });
  it("binds report receipts to the production, original input, actor, version and fingerprint", async () => {
    for (const row of [{ ...report(), productionOrderId: createEntityId() }, { ...report(), createdBy: createEntityId() }, { ...report(), productionVersionId: createEntityId() },
      { ...report(), basisFingerprint: "b".repeat(64) }, { ...report(), input: { ...reportInput(), idempotencyKey: "different-report-key" } }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ ...reportResult(), report: row }, { status: 201 })); expect((await POST(post("reports", reportInput()), route("reports"))).status).toBe(502);
    }
  });
  it("binds review receipts to the original report, previous review and complete original body", async () => {
    for (const row of [{ ...review(), reportId: createEntityId() }, { ...review(), previousReviewId: createEntityId() }, { ...review(), createdBy: createEntityId() },
      { ...review(), input: { ...reviewInput(), stoppedDelta: 1 } }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ ...reviewResult(), review: row }, { status: 201 })); expect((await POST(post("reviews", reviewInput()), route("reviews"))).status).toBe(502);
    }
  });
  it("accepts equivalent UTC timestamp presentation without replacing the original request", async () => {
    const input = { ...reportInput(), observedAt: "2026-10-21T00:00:00Z" };
    mocks.upstream.mockResolvedValueOnce(Response.json(reportResult(), { status: 201 })); expect((await POST(post("reports", input), route("reports"))).status).toBe(201);
    expect(JSON.parse(mocks.upstream.mock.calls[0]![1].body)).toEqual(input);
  });
  it("checks both live history cursors against actual rows, limits and the requested before position", async () => {
    const view = workspace(); mocks.upstream.mockResolvedValueOnce(Response.json({ ...view, reportsNextCursor: reportId })); expect((await GET(get("?limit=1"), route())).status).toBe(200);
    for (const invalid of [{ ...view, reportsNextCursor: earlierId }, { ...view, reports: [report(), { ...report(), id: earlierId }] }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(invalid)); expect((await GET(get("?limit=1"), route())).status).toBe(502);
    }
    mocks.upstream.mockResolvedValueOnce(Response.json(view)); expect((await GET(get(`?reportsBefore=${earlierId}`), route())).status).toBe(502);
  });
  it("refuses history rows whose inner original source differs from the immutable receipt", async () => {
    const view = workspace();
    for (const invalid of [{ ...view, reports: [{ ...report(), input: { ...reportInput(), productionVersionId: createEntityId() } }] },
      { ...view, reviews: [{ ...review(), input: { ...reviewInput(), reportId: createEntityId() } }] }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(invalid)); expect((await GET(get(), route())).status).toBe(502);
    }
  });
  it("rejects workspace parent substitution, malformed receipts and unexpected success statuses", async () => {
    const view = workspace(); mocks.upstream.mockResolvedValueOnce(Response.json({ ...view, basis: { ...view.basis, productionOrderId: createEntityId() }, reports: [] })); expect((await GET(get(), route())).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...authority(), report: { id: reportId } }, { status: 201 })); expect((await POST(post("reports", reportInput()), route("reports"))).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(Response.json(reportResult())); expect((await POST(post("reports", reportInput()), route("reports"))).status).toBe(502);
  });
  it("passes only known authority_changed while sanitizing all error details", async () => {
    for (const status of [400, 401, 403, 404, 409, 422, 503, 500]) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ code: "different_code", message: "SYNTHETIC_PRIVATE_ERROR" }, { status })); const response = await GET(get(), route());
      expect(response.status).toBe(status === 500 ? 502 : status); expect(await response.text()).not.toContain("SYNTHETIC_PRIVATE_ERROR");
    }
    mocks.upstream.mockResolvedValueOnce(Response.json({ code: "authority_changed", internal: "SYNTHETIC_PRIVATE_ERROR" }, { status: 409 })); const response = await GET(get(), route());
    expect(await response.json()).toMatchObject({ code: "authority_changed" });
  });
  it("refuses oversized upstream data without returning a truncated private record", async () => {
    mocks.upstream.mockResolvedValueOnce(new Response(JSON.stringify({ privateData: "X".repeat(8_388_608) })));
    const response = await GET(get(), route()); expect(response.status).toBe(502); expect(await response.text()).not.toContain("privateData");
  });
});
