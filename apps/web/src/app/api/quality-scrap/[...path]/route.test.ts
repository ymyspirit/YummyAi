import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { QualityScrapResultSchema, QualityScrapWorkspaceSchema, type AllocateQualityScrapInput } from "@yummyai/contracts/order/quality-scrap";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn(), identity: vi.fn(), current: vi.fn(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const ids = { production: createEntityId(), version: createEntityId(), root: createEntityId(), group: createEntityId(), lot: createEntityId(), report: createEntityId(),
  order: createEntityId(), actor: createEntityId(), tenant: createEntityId() };
const reviewId = "019f0000-0000-7000-8000-000000000010", earlierId = "019f0000-0000-7000-8000-000000000009";
const context: TenantContext = { tenantId: ids.tenant, userId: ids.actor, permissions: ["order:read", "order:write"], dataScope: "tenant" };
const origin = "http://localhost:3130", at = "2026-10-21T04:30:00.123Z";
const stamp = () => ({ contextAuthority: erpSessionAuthority(context), access: { canRead: true as const, canWrite: true } });
const input = (): AllocateQualityScrapInput => ({ idempotencyKey: "synthetic-exact-scrap-request", productionVersionId: ids.version,
  expectedProductionProjectionVersion: 6, expectedRootInspectionId: ids.root, expectedQuantityReviewId: ids.lot, expectedScrapReviewId: null,
  expectedBasisFingerprint: "a".repeat(64), physicalSegregationConfirmed: true, occurredAt: at, evidenceCode: "SYNTHETIC_ACTUAL_SCRAP", evidenceAssetIds: [],
  allocations: [{ qualityGroupId: ids.group, sourceQuantityReviewId: ids.lot, quantity: 2 }] });
const review = () => ({ id: reviewId, productionOrderId: ids.production, productionVersionId: ids.version, rootInspectionId: ids.root,
  quantityReviewId: ids.lot, previousReviewId: null, input: input(), createdBy: ids.actor, createdAt: at });
const workspace = () => QualityScrapWorkspaceSchema.parse({ ...stamp(), basis: { productionOrderId: ids.production, orderId: ids.order,
  productionVersionId: ids.version, projectionVersion: 6, rootInspectionId: ids.root, quantityReviewId: ids.lot, scrapReviewId: null,
  actualScrappedQuantity: 2, mappedScrappedQuantity: 0, unassignedQuantity: 2, unassignedGroupQuantity: 2, outsideRootQuantity: 0, ambiguousQuantity: 0,
  groups: [{ qualityGroupId: ids.group, inspectionId: ids.root, label: "Synthetic original failed group", quantity: 6, inspectionRecordedAt: at,
    active: true, result: "failed", scrappedQuantity: 0, reinspectableQuantity: 6, maxAllocatableQuantity: 2, remakeEligible: true,
    remakeQuantity: 0, remainingRemakeQuantity: 6, remainingScrapRemakeQuantity: 0, allocatedQuantity: 0, allocationBlockers: [] }],
  lots: [{ sourceQuantityReviewId: ids.lot, reportId: ids.report, observedAt: at, reviewedAt: at, quantity: 2, allocatedQuantity: 0, remainingQuantity: 2, scope: "groupable" }],
  blockers: [], fingerprint: "a".repeat(64) }, reviews: [], nextCursor: null });
const result = () => QualityScrapResultSchema.parse({ ...stamp(), review: review(), replayed: false });
const route = (write = false) => ({ params: Promise.resolve({ path: ["orders", ids.production, "quality-scrap", ...(write ? ["reviews"] : [])] }) });
const get = (query = "") => new Request(`${origin}/api/quality-scrap/orders/${ids.production}/quality-scrap${query}`);
const post = (body: unknown = input(), requestOrigin = origin, contentType = "application/json") => new Request(`${origin}/api/quality-scrap/orders/${ids.production}/quality-scrap/reviews`, {
  method: "POST", headers: { origin: requestOrigin, "content-type": contentType }, body: JSON.stringify(body),
});
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("API_BASE_URL", "http://127.0.0.1:29100/"); mocks.identity.mockReset().mockResolvedValue({ view: context });
  mocks.current.mockReset().mockResolvedValue(undefined); mocks.upstream.mockReset();
  mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); });
afterEach(() => vi.unstubAllEnvs());

describe("personal quality scrap BFF binds original lots and immutable receipts", () => {
  it("reads the exact current production with no-store and personal identity checks before and after I/O", async () => {
    const value = workspace(); mocks.upstream.mockResolvedValueOnce(Response.json(value)); const response = await GET(get(), route());
    expect(response.status).toBe(200); expect(await response.json()).toEqual(value); expect(mocks.current).toHaveBeenCalledTimes(2);
    const [url, init] = mocks.upstream.mock.calls[0]!;
    expect(url).toBe(`http://127.0.0.1:29100/v1/production/orders/${ids.production}/quality-scrap?limit=20`);
    expect(init.cache).toBe("no-store"); expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).has("authorization")).toBe(false); expect(new Headers(init.headers).has("x-tenant-id")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("keeps a null physical scrap amount unknown instead of inventing a zero", async () => {
    const value = workspace(); value.basis = { ...value.basis, actualScrappedQuantity: null, unassignedQuantity: 0, unassignedGroupQuantity: 0, lots: [], groups: [] };
    mocks.upstream.mockResolvedValueOnce(Response.json(value)); const response = await GET(get(), route());
    expect(response.status).toBe(200); expect((await response.json()).basis.actualScrappedQuantity).toBeNull();
  });
  it("posts the exact original key and lot pins and returns the immutable actual review", async () => {
    const value = result(); mocks.upstream.mockResolvedValueOnce(Response.json(value, { status: 201 })); const response = await POST(post(), route(true));
    expect(response.status).toBe(201); expect(await response.json()).toEqual(value);
    expect(JSON.parse(mocks.upstream.mock.calls[0]![1].body)).toEqual(input()); expect(mocks.current).toHaveBeenCalledTimes(2);
  });
  it("accepts equivalent normalized IDs and UTC dates without replacing the submitted key or body", async () => {
    const original = { ...input(), productionVersionId: ids.version.toUpperCase(), expectedRootInspectionId: ids.root.toUpperCase(),
      occurredAt: "2026-10-21T04:30:00.123000Z" };
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...result(), replayed: true }, { status: 201 }));
    expect((await POST(post(original), route(true))).status).toBe(201);
    expect(JSON.parse(mocks.upstream.mock.calls[0]![1].body)).toEqual(original);
  });
  it.each(["?tenantId=caller", "?limit=1&limit=1", "?before=wrong", "?limit=51"])("rejects unsupported or ambiguous query %s", async query => {
    expect((await GET(get(query), route())).status).toBe(400); expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("rejects invalid paths and any write query before reaching the API", async () => {
    expect((await GET(get(), { params: Promise.resolve({ path: ["orders", "invalid", "quality-scrap"] }) })).status).toBe(404);
    expect((await GET(get(), route(true))).status).toBe(404);
    const query = new Request(`${post().url}?limit=1`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input()) });
    expect((await POST(query, route(true))).status).toBe(400); expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("requires same Origin, JSON and the complete bounded input without inferred capacity effects", async () => {
    expect((await POST(post(input(), "https://invalid.example"), route(true))).status).toBe(403);
    expect((await POST(post(input(), origin, "text/plain"), route(true))).status).toBe(415);
    expect((await POST(post({ ...input(), evidenceCode: "X".repeat(263000) }), route(true))).status).toBe(413);
    expect((await POST(post({ ...input(), releasedUnits: 2 }), route(true))).status).toBe(400);
    expect((await POST(post({ ...input(), physicalSegregationConfirmed: false }), route(true))).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("does not substitute a service identity when the personal session is unavailable", async () => {
    mocks.identity.mockRejectedValueOnce(new PersonalSessionError(401, "login_required"));
    expect((await GET(get(), route())).status).toBe(401); expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("keeps tenant Read and tenant Write independent under mixed permission scopes", async () => {
    const writeSelf: TenantContext = { ...context, permissionScopes: { "order:read": "tenant", "order:write": "self" } };
    mocks.identity.mockResolvedValueOnce({ view: writeSelf }); expect((await POST(post(), route(true))).status).toBe(403);
    const readSelf: TenantContext = { ...context, permissionScopes: { "order:read": "self", "order:write": "tenant" } };
    mocks.identity.mockResolvedValueOnce({ view: readSelf }); expect((await GET(get(), route())).status).toBe(403);
    const value = { ...workspace(), contextAuthority: erpSessionAuthority(writeSelf), access: { canRead: true, canWrite: false } };
    mocks.identity.mockResolvedValueOnce({ view: writeSelf }); mocks.upstream.mockResolvedValueOnce(Response.json(value));
    expect((await GET(get(), route())).status).toBe(200);
  });
  it("clears trust in a response if the actual session changes after its upstream read", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json(workspace())); mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const response = await GET(get(), route()); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "authority_changed" });
  });
  it("rejects a valid record stamped for a different current authority", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...workspace(), contextAuthority: erpSessionAuthority({ ...context, permissions: ["order:read"] }), access: { canRead: true, canWrite: false } }));
    const response = await GET(get(), route()); expect(response.status).toBe(409); expect((await response.json()).code).toBe("authority_changed");
  });
  it("binds receipts to the original production, actor, request key and exact incremental source lot", async () => {
    for (const changed of [{ ...review(), productionOrderId: createEntityId() }, { ...review(), createdBy: createEntityId() },
      { ...review(), input: { ...input(), idempotencyKey: "synthetic-another-request" } },
      { ...review(), input: { ...input(), allocations: [{ ...input().allocations[0]!, sourceQuantityReviewId: createEntityId() }] } },
      { ...review(), input: { ...input(), allocations: [{ ...input().allocations[0]!, quantity: 1 }] } }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ ...result(), review: changed }, { status: 201 }));
      expect((await POST(post(), route(true))).status).toBe(502);
    }
  });
  it("refuses header pins that contradict the saved original even when the visible target ID is correct", async () => {
    for (const field of ["productionVersionId", "rootInspectionId", "quantityReviewId", "previousReviewId"])
      for (const method of ["GET", "POST"] as const) {
        const changed = { ...review(), [field]: createEntityId() };
        mocks.upstream.mockResolvedValueOnce(Response.json(method === "GET" ? { ...workspace(), reviews: [changed] } : { ...result(), review: changed }, { status: method === "GET" ? 200 : 201 }));
        expect((method === "GET" ? await GET(get(), route()) : await POST(post(), route(true))).status).toBe(502);
      }
  });
  it("checks history order, true page limit, before position and the exact next row anchor", async () => {
    const value = { ...workspace(), reviews: [review()], nextCursor: reviewId };
    mocks.upstream.mockResolvedValueOnce(Response.json(value)); expect((await GET(get("?limit=1"), route())).status).toBe(200);
    for (const invalid of [{ ...value, nextCursor: earlierId }, { ...value, reviews: [review(), { ...review(), id: earlierId }] },
      { ...value, reviews: [review(), review()], nextCursor: null }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(invalid)); expect((await GET(get("?limit=1"), route())).status).toBe(502);
    }
    mocks.upstream.mockResolvedValueOnce(Response.json(value)); expect((await GET(get(`?before=${earlierId}`), route())).status).toBe(502);
  });
  it("rejects duplicate group and lot projections and a different production basis", async () => {
    const value = workspace();
    for (const changed of [{ ...value, basis: { ...value.basis, productionOrderId: createEntityId() } },
      { ...value, basis: { ...value.basis, groups: [...value.basis.groups, ...value.basis.groups] } },
      { ...value, basis: { ...value.basis, lots: [...value.basis.lots, ...value.basis.lots] } }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(changed)); expect((await GET(get(), route())).status).toBe(502);
    }
  });
  it("refuses malformed or oversized data and never returns a truncated success receipt", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...stamp(), review: { id: reviewId } }, { status: 201 }));
    expect((await POST(post(), route(true))).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(new Response(JSON.stringify({ privatePayload: "X".repeat(8388608) })));
    const response = await GET(get(), route()); expect(response.status).toBe(502); expect(await response.text()).not.toContain("privatePayload");
  });
  it("requires the actual success status and preserves only literal authority_changed from bounded errors", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json(result())); expect((await POST(post(), route(true))).status).toBe(502);
    for (const status of [400, 401, 403, 404, 409, 413, 422, 429, 503, 500]) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ code: "private_code", message: "SYNTHETIC_PRIVATE_DETAIL" }, { status }));
      const response = await GET(get(), route()); expect(response.status).toBe(status === 500 ? 502 : status);
      expect(await response.text()).not.toContain("SYNTHETIC_PRIVATE_DETAIL");
    }
    mocks.upstream.mockResolvedValueOnce(Response.json({ code: "authority_changed", privateData: "SYNTHETIC_PRIVATE_DETAIL" }, { status: 409 }));
    expect(await (await GET(get(), route())).json()).toMatchObject({ code: "authority_changed" });
  });
});
