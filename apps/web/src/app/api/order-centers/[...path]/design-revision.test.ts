import { randomUUID } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { Permission } from "@yummyai/authz/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const permissions = [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead, Permission.DesignRead, Permission.DesignWrite, Permission.DesignReview, Permission.AssetRead];
const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), displayName: "Synthetic reviewer", organizationName: "Synthetic organization",
  dataScope: "tenant", permissions, permissionScopes: Object.fromEntries(permissions.map(permission => [permission, "tenant"])) };
const lineId = createEntityId(), parentRunId = createEntityId(), projectId = createEntityId(), versionId = createEntityId(), childRunId = createEntityId();
const input = { runId: parentRunId, expectedRevision: 3, expectedEditorVersionId: versionId, idempotencyKey: randomUUID(), reason: "只修主体耳朵边缘 保持构图", mode: "image_edit", attachments: [] };
const path = ["lines", lineId, "design-agent", "revise"], stamp = erpSessionAuthority(actor);
const context = (target = path) => ({ params: Promise.resolve({ path: target }) });
function request(target = path, body: unknown = input, authority: string | null = stamp, method = "POST") {
  return new Request(`http://web.test/api/order-centers/${target.join("/")}`, { method,
    headers: { ...(method === "POST" ? { "content-type": "application/json", origin: "http://web.test" } : {}), ...(authority ? { "x-yummyai-context-authority": authority } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
}
function view() { return { run: { id: childRunId, workItemId: lineId, workRevisionId: createEntityId(), revision: 1, status: "queued", executorKey: "strict-pillow_photo", recipeVersion: "2", policyVersion: "order-design-v1", modelRouteId: createEntityId(),
  projectId, currentEditorVersionId: versionId, createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z", errorCode: null, canResume: false, canTakeOver: true, estimatedCostUsd: null, actualCostUsd: null, costStatus: "unknown", qualityDiagnostics: [], steps: [],
  revisionFeedback: { requestId: input.idempotencyKey, parentRunId, baseProjectId: projectId, baseVersionId: versionId, baseDocumentChecksum: "a".repeat(64), reason: input.reason, mode: "image_edit", attachments: [] } } }; }

describe("Personal AI artwork revision boundary", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue();
    mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); process.env.API_BASE_URL = "http://api.test"; });
  it("forwards one explicit revision intent and returns its correlated child with a current-person stamp", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json(view()));
    const response = await POST(request(), context());
    expect(response.status).toBe(200); expect(response.headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.upstream.mock.calls[0]!;
    expect(url).toBe(`http://api.test/v1/order-centers/${path.join("/")}`); expect(JSON.parse(String(init?.body))).toEqual(input);
    expect((await response.json()).run.id).toBe(childRunId);
  });
  it("refuses a stale/missing identity stamp and a reviewer without execution rights before sending bytes", async () => {
    expect((await POST(request(path, input, null), context())).status).toBe(409);
    const reviewer: ErpSessionView = { ...actor, permissions: [Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignReview], permissionScopes: { [Permission.OrderRead]: "tenant", [Permission.OrderPiiRead]: "tenant", [Permission.DesignReview]: "tenant" } };
    mocks.identity.mockResolvedValueOnce({ view: reviewer });
    expect((await POST(request(path, input, erpSessionAuthority(reviewer)), context())).status).toBe(403); expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("rejects query injection, wrong-origin writes and a manufactured geometry parameter", async () => {
    const invalidQuery = new Request(request().url + "?tenantId=caller", request());
    expect((await POST(invalidQuery, context())).status).toBe(400);
    const foreignOrigin = request(); foreignOrigin.headers.set("origin", "http://other.test");
    expect((await POST(foreignOrigin, context())).status).toBe(403);
    expect((await POST(request(path, { ...input, contourRoundingPx: 30 }), context())).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("does not acknowledge another order or an uncorrelated request after an uncertain write", async () => {
    const wrong = view(); wrong.run.workItemId = createEntityId(); mocks.upstream.mockResolvedValueOnce(Response.json(wrong));
    expect((await POST(request(), context())).status).toBe(502);
    const uncorrelated = view(); uncorrelated.run.revisionFeedback.requestId = randomUUID(); mocks.upstream.mockResolvedValueOnce(Response.json(uncorrelated));
    expect((await POST(request(), context())).status).toBe(502); expect(mocks.upstream).toHaveBeenCalledTimes(2);
  });
  it("checks authority again after the committed write without retrying the provider", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json(view()));
    mocks.current.mockResolvedValueOnce().mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const response = await POST(request(), context()); expect(response.status).toBe(409); expect(await response.text()).not.toContain(input.reason); expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });
  it("fences the read used to reconcile an unknown revision and rejects foreign line evidence", async () => {
    const target = path.slice(0, 3); mocks.upstream.mockResolvedValueOnce(Response.json(view()));
    const response = await GET(request(target, undefined, stamp, "GET"), context(target));
    expect(response.status).toBe(200); expect(response.headers.get("x-yummyai-context-authority")).toBe(stamp);
    const wrong = view(); wrong.run.workItemId = createEntityId(); mocks.upstream.mockResolvedValueOnce(Response.json(wrong));
    expect((await GET(request(target, undefined, stamp, "GET"), context(target))).status).toBe(502);
  });
  it("returns reference screenshots only through the private image path with a current-person stamp", async () => {
    const target = [...path.slice(0, 3), "revision-attachments", childRunId, createEntityId()];
    mocks.upstream.mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }));
    const response = await GET(request(target, undefined, stamp, "GET"), context(target));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("content-security-policy")).toContain("sandbox");
    mocks.upstream.mockResolvedValueOnce(new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }));
    expect((await GET(request(target, undefined, stamp, "GET"), context(target))).status).toBe(502);
    expect((await GET(request(target, undefined, null, "GET"), context(target))).status).toBe(409);
  });
});
