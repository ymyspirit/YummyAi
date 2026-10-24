import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ChangeFactoryErpBindingSchema } from "@yummyai/contracts/order/factory-erp-binding";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn(), identity: vi.fn(), current: vi.fn(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const origin = "http://localhost:3130", hash = "a".repeat(64), ids = { binding: createEntityId(), change: createEntityId(), source: createEntityId(), factory: createEntityId() };
const actor: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant", permissions: ["order:read", "order:write", "order:pii:read", "design:read", "asset:read"] };
const input = () => ChangeFactoryErpBindingSchema.parse({ action: "release", expectedRevision: 1, expectedItemsChecksum: hash, expectedObservationSequence: 4,
  source: { importId: ids.source, fileChecksum: hash, previewChecksum: hash, rowNumber: 2 }, reasonCode: "wrong_group", idempotencyKey: createEntityId(), confirmed: true });
const result = (body: ReturnType<typeof input>) => ({ id: ids.change, bindingId: ids.binding, factoryId: ids.factory, action: "release", reasonCode: body.reasonCode,
  source: body.source, originalRevision: 1, originalItemsChecksum: hash, originalObservationSequence: 4, replacementBindingId: null, replacementRevision: null, application: null,
  requestChecksum: createHash("sha256").update(canonicalJson({ version: 1, operation: "factory-erp-binding-change", bindingId: ids.binding, input: body })).digest("hex"), createdAt: "2026-10-21T08:00:00.000Z" });
const context = (path = ["bindings", ids.binding, "changes"]) => ({ params: Promise.resolve({ path }) });
const get = (query = "", path = `bindings/${ids.binding}/changes`) => new Request(`${origin}/api/factory-erp-import/${path}${query}`);
const post = (body: unknown, sourceOrigin = origin) => new Request(`${origin}/api/factory-erp-import/bindings/${ids.binding}/changes`, { method: "POST", headers: { origin: sourceOrigin, "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130"); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue(undefined);
  mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status }));
});
afterEach(() => vi.unstubAllEnvs());

describe("personal factory binding change BFF", () => {
  it("forwards the exact fixed intent and only accepts its matching immutable receipt", async () => {
    const body = input(), value = result(body); mocks.upstream.mockResolvedValue(Response.json(value, { status: 201 }));
    const response = await POST(post(body), context()); expect(response.status).toBe(201); expect(await response.json()).toEqual(value);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(mocks.upstream.mock.calls[0]![1].body)).toEqual(body); expect(mocks.current).toHaveBeenCalledTimes(2);
  });
  it("reads complete historical changes by binding and original change ID without writes", async () => {
    const value = result(input()); mocks.upstream.mockResolvedValueOnce(Response.json({ items: [value], nextCursor: null }));
    expect((await GET(get(), context())).status).toBe(200);
    mocks.upstream.mockResolvedValueOnce(Response.json(value));
    expect((await GET(get("", `bindings/${ids.binding}/changes/${ids.change}`), context(["bindings", ids.binding, "changes", ids.change]))).status).toBe(200);
    expect(mocks.upstream.mock.calls.every(call => call[1].method === "GET")).toBe(true);
  });
  it("rejects ambiguous pagination, unsupported queries and write paths before upstream", async () => {
    for (const query of ["?tenantId=caller", "?limit=1&limit=1", "?cursor=bad", "?limit=101"])
      expect((await GET(get(query), context())).status).toBe(400);
    expect((await GET(get(), context(["bindings", ids.binding, "release"]))).status).toBe(404);
    expect((await POST(post({ ...input(), note: "private" }), context())).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("requires same origin and every current tenant permission for new commands", async () => {
    expect((await POST(post(input(), "https://untrusted.invalid"), context())).status).toBe(403);
    for (const permission of actor.permissions) {
      mocks.identity.mockResolvedValue({ view: { ...actor, permissionScopes: { ...Object.fromEntries(actor.permissions.map(p => [p, "tenant"])), [permission]: "own" } } });
      expect((await POST(post(input()), context())).status).toBe(403);
    }
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("blocks a late result after the current personal authority changes", async () => {
    const body = input(); mocks.upstream.mockResolvedValue(Response.json(result(body), { status: 201 }));
    mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    expect((await POST(post(body), context())).status).toBe(409);
  });
  it("rejects a different root, source, original sequence or request checksum", async () => {
    const body = input(), receipt = result(body);
    for (const mutation of [{ bindingId: createEntityId() }, { source: { ...body.source, rowNumber: 3 } }, { originalObservationSequence: 5 }, { requestChecksum: "b".repeat(64) }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ ...receipt, ...mutation }, { status: 201 }));
      expect((await POST(post(body), context())).status).toBe(502);
    }
  });
  it("rejects cross-factory or duplicate binding history pages", async () => {
    const path = ["bindings"], url = get(`?factoryId=${ids.factory}`, "bindings");
    const value = { id: ids.binding, factoryId: createEntityId(), revision: 1, previousBindingId: null, nextBindingId: null, releasedBy: null, state: "active", itemsChecksum: hash,
      quantity: 2, sourceImportId: ids.source, observationSequence: 4, recordedStatus: "shipped", recordedException: null, createdAt: "2026-10-21T08:00:00.000Z" };
    mocks.upstream.mockResolvedValueOnce(Response.json({ items: [value], nextCursor: null })); expect((await GET(url, context(path))).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(Response.json({ items: [{ ...value, factoryId: ids.factory }, { ...value, factoryId: ids.factory }], nextCursor: null }));
    expect((await GET(get(`?factoryId=${ids.factory}`, "bindings"), context(path))).status).toBe(502);
  });
});
