import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ReviewFactoryErpVoidSchema } from "@yummyai/contracts/order/factory-erp-void-review";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn(), identity: vi.fn(), current: vi.fn(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const origin = "http://localhost:3130", hash = "a".repeat(64), at = "2026-10-21T08:00:00.000Z";
const ids = { binding: createEntityId(), factory: createEntityId(), source: createEntityId(), observation: createEntityId(), review: createEntityId() };
const actor: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant", permissions: ["order:read", "order:write", "order:pii:read", "design:read", "asset:read"] };
const observation = () => ({ id: ids.observation, sequence: 2, importId: ids.source, rowNumber: 2, rowChecksum: hash, fileChecksum: hash, previewChecksum: hash, recordedAt: at,
  sourceReadable: false, latestReview: null, pending: true, requiresOrderHandling: false });
const basis = () => ({ bindingId: ids.binding, factoryId: ids.factory, bindingRevision: 1, itemsChecksum: hash, state: "active", observationSequence: 2,
  summary: { total: 1, pending: 1, requiresOrderHandling: 0, latest: observation(), nextPending: observation() } });
const input = () => {
  const { id, sequence, importId, rowNumber, rowChecksum, fileChecksum, previewChecksum, recordedAt } = observation();
  return ReviewFactoryErpVoidSchema.parse({ expectedBindingRevision: 1, expectedItemsChecksum: hash, expectedObservationSequence: 2,
    observation: { id, sequence, importId, rowNumber, rowChecksum, fileChecksum, previewChecksum, recordedAt }, expectedPreviousReviewId: null,
    source: { importId: ids.source, fileChecksum: hash, previewChecksum: hash, rowNumber: 2 },
    outcome: "confirmed_voided", reasonCode: "factory_contact", provenance: "operator_attested", confirmed: true, idempotencyKey: createEntityId() });
};
const receipt = (body = input()) => ({ id: ids.review, bindingId: ids.binding, factoryId: ids.factory, observation: body.observation, source: body.source,
  originalBindingRevision: body.expectedBindingRevision, originalItemsChecksum: body.expectedItemsChecksum, originalObservationSequence: body.expectedObservationSequence,
  reviewRevision: 1, previousReviewId: null, outcome: body.outcome, reasonCode: body.reasonCode, provenance: body.provenance,
  requestChecksum: createHash("sha256").update(canonicalJson({ version: 1, operation: "factory-erp-void-review", bindingId: ids.binding, input: body })).digest("hex"), createdAt: at });
const context = (suffix: string[] = ["void-reviews"]) => ({ params: Promise.resolve({ path: ["bindings", ids.binding, ...suffix] }) });
const get = (suffix: string, query = "") => new Request(`${origin}/api/factory-erp-import/bindings/${ids.binding}/${suffix}${query}`);
const post = (body: unknown, requestOrigin = origin) => new Request(`${origin}/api/factory-erp-import/bindings/${ids.binding}/void-reviews`, {
  method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130"); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue(undefined);
  mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status }));
});
afterEach(() => vi.unstubAllEnvs());

describe("personal exact factory void observation review BFF", () => {
  it("forwards a fixed observation and original source and verifies its actual immutable receipt", async () => {
    const body = input(), value = receipt(body); mocks.upstream.mockResolvedValue(Response.json(value, { status: 201 }));
    const response = await POST(post(body), context()); expect(response.status).toBe(201); expect(await response.json()).toEqual(value);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(JSON.parse(mocks.upstream.mock.calls[0]![1].body)).toEqual(body);
    expect(mocks.current).toHaveBeenCalledTimes(2);
  });
  it("reads old exact observations and complete counts without changing their source identity", async () => {
    const page = { basis: basis(), items: [observation()], nextCursor: null };
    mocks.upstream.mockResolvedValueOnce(Response.json(page));
    const response = await GET(get("void-observations", "?limit=20"), context(["void-observations"]));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(page);
    mocks.upstream.mockResolvedValueOnce(Response.json({ basis: basis(), observation: observation() }));
    expect((await GET(get(`void-observations/${ids.observation}`), context(["void-observations", ids.observation]))).status).toBe(200);
  });
  it("reads result history including observation-filtered pages and the exact review ID", async () => {
    const value = receipt(); mocks.upstream.mockResolvedValueOnce(Response.json({ items: [value], nextCursor: null }));
    expect((await GET(get("void-reviews", `?observationId=${ids.observation}`), context())).status).toBe(200);
    mocks.upstream.mockResolvedValueOnce(Response.json(value));
    expect((await GET(get(`void-reviews/${ids.review}`), context(["void-reviews", ids.review]))).status).toBe(200);
    expect(mocks.upstream.mock.calls.every(call => call[1].method === "GET")).toBe(true);
  });
  it("rejects unsupported and ambiguous queries and mismatched outcome evidence before upstream", async () => {
    for (const query of ["?tenantId=caller", "?limit=101", "?cursor=bad", "?limit=20&limit=20"])
      expect((await GET(get("void-observations", query), context(["void-observations"]))).status).toBe(400);
    expect((await POST(post({ ...input(), reasonCode: "binding_mismatch" }), context())).status).toBe(400);
    expect((await POST(post({ ...input(), note: "private" }), context())).status).toBe(400);
    expect((await GET(get(`void-reviews/${ids.review}`, "?limit=1"), context(["void-reviews", ids.review]))).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("requires same origin and all five current tenant permissions for a new review", async () => {
    expect((await POST(post(input(), "https://untrusted.invalid"), context())).status).toBe(403);
    for (const permission of actor.permissions) {
      mocks.identity.mockResolvedValue({ view: { ...actor, permissionScopes: { ...Object.fromEntries(actor.permissions.map(value => [value, "tenant"])), [permission]: "self" } } });
      expect((await POST(post(input()), context())).status).toBe(403);
    }
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("permits current read-only history but refuses writing", async () => {
    mocks.identity.mockResolvedValue({ view: { ...actor, permissions: actor.permissions.filter(value => value !== "order:write") } });
    mocks.upstream.mockResolvedValueOnce(Response.json({ items: [receipt()], nextCursor: null }));
    expect((await GET(get("void-reviews"), context())).status).toBe(200);
    expect((await POST(post(input()), context())).status).toBe(403);
  });
  it("rejects wrong observation, parent, previous review, result sequence and canonical checksum", async () => {
    const body = input(), value = receipt(body);
    for (const change of [{ bindingId: createEntityId() }, { observation: { ...value.observation, rowNumber: 3 } },
      { previousReviewId: createEntityId(), reviewRevision: 2 }, { originalObservationSequence: 3 }, { requestChecksum: "b".repeat(64) }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ ...value, ...change }, { status: 201 }));
      expect((await POST(post(body), context())).status).toBe(502);
    }
  });
  it("binds descending observation pages to the actual sequence cursor and exact parent", async () => {
    const good = { basis: basis(), items: [observation()], nextCursor: null };
    for (const value of [{ ...good, basis: { ...basis(), bindingId: createEntityId() } }, { ...good, nextCursor: 1 },
      { ...good, items: [observation(), { ...observation(), sequence: 1 }] }, { ...good, items: [{ ...observation(), sequence: 3 }] }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(value));
      expect((await GET(get("void-observations"), context(["void-observations"]))).status).toBe(502);
    }
    mocks.upstream.mockResolvedValueOnce(Response.json(good));
    expect((await GET(get("void-observations", "?cursor=2"), context(["void-observations"]))).status).toBe(502);
  });
  it("rejects result pages with another exact observation or another requested review ID", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ items: [receipt()], nextCursor: null }));
    expect((await GET(get("void-reviews", `?observationId=${createEntityId()}`), context())).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...receipt(), id: createEntityId() }));
    expect((await GET(get(`void-reviews/${ids.review}`), context(["void-reviews", ids.review]))).status).toBe(502);
  });
  it("rejects a late response after authority changes and only exposes the literal authority error", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json(receipt(), { status: 201 }));
    mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    expect((await POST(post(input()), context())).status).toBe(409);
    mocks.current.mockResolvedValue(undefined); mocks.upstream.mockResolvedValueOnce(Response.json({ code: "authority_changed", message: "private upstream body" }, { status: 409 }));
    const response = await GET(get("void-reviews"), context()); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "authority_changed" });
  });
});
