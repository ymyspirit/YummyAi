import { createHash, randomUUID } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_LOOP_VERSION, CreateAgentLoopSchema, defaultAgentLoopLimits } from "@yummyai/contracts/ai/agent-loop";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";

const mock = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mock.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mock.identity, assertErpIdentityCurrent: mock.current, erpAuthFailure: mock.failure }));
import { GET, POST } from "./route";

const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), displayName: "Synthetic operator",
  organizationName: "Synthetic tenant", permissions: ["workflow:read", "workflow:run"], permissionScopes: { "workflow:read": "tenant", "workflow:run": "tenant" }, dataScope: "tenant" };
const stamp = erpSessionAuthority(actor), origin = "http://web.test", hash = "a".repeat(64), id = createEntityId();
const contract = { contractVersion: "native-harness-v1", executorKey: "erp.agent.loop", skill: { key: "erp.agent.loop", version: AGENT_LOOP_VERSION, checksum: hash },
  tools: [{ key: "agent.loop.decide", version: AGENT_LOOP_VERSION, checksum: hash }], checksum: hash };
const input = () => CreateAgentLoopSchema.parse({ version: AGENT_LOOP_VERSION, requestId: randomUUID(), modelId: createEntityId(), goal: "Synthetic personal bounded goal",
  allowedTools: ["inventory.balances.page"], limits: defaultAgentLoopLimits(), maxCostUsd: 0.1, executionContract: contract });
const run = (body: ReturnType<typeof input>) => ({ version: AGENT_LOOP_VERSION, id, requestId: body.requestId,
  requestChecksum: createHash("sha256").update(canonicalJson(body)).digest("hex"), contextAuthority: stamp, revision: 1, status: "queued", goal: body.goal,
  modelLabel: "Synthetic priced route", allowedTools: body.allowedTools, executionContract: contract, limits: body.limits,
  cost: { capUsd: "0.100000", knownCostUsd: "0.000000", reservedUsd: "0.100000", coverage: "known", modelTurns: 0 }, toolCalls: 0, observedRows: 0,
  stopRequestedAt: null, errorCode: null, createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z",
  deadlineAt: "2026-10-22T00:10:00.000Z", expiresAt: "2026-10-23T00:00:00.000Z", privateAvailable: true,
  stepsComplete: true, steps: [], collections: [], result: null, verification: "pending" });
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (path: string, body?: unknown, authority: string | null = stamp, requestOrigin = origin) => new Request(origin + "/api/agent-loops/" + path,
  { method: body === undefined ? "GET" : "POST", headers: { origin: requestOrigin, "content-type": "application/json", ...(authority ? { "x-yummyai-context-authority": authority } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });

describe("Bounded Agent loop personal BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mock.upstream.mockReset(); mock.identity.mockResolvedValue({ view: actor }); mock.current.mockResolvedValue();
    mock.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); process.env.API_BASE_URL = "http://api.test";
  });

  it("admits only exact personal, same-origin, strict typed bounded requests and never forwards identity, dynamic tools or extra query fields", async () => {
    const body = input();
    expect((await POST(request("runs", body, null), context("runs"))).status).toBe(409);
    expect((await POST(request("runs", body, stamp, "http://other.test"), context("runs"))).status).toBe(403);
    expect((await POST(request("runs", { ...body, allowedTools: ["orders.cancel"] }), context("runs"))).status).toBe(400);
    expect((await POST(request("runs", { ...body, tenantId: actor.tenantId }), context("runs"))).status).toBe(400);
    expect((await GET(request("workspace?tenantId=other"), context("workspace"))).status).toBe(400);
    expect((await GET(request("receipts?requestId=" + body.requestId + "&requestId=" + body.requestId + "&requestChecksum=" + hash), context("receipts"))).status).toBe(400);
    const readOnly = { ...actor, permissions: ["workflow:read"] }; mock.identity.mockResolvedValueOnce({ view: readOnly });
    expect((await POST(request("runs", body, erpSessionAuthority(readOnly)), context("runs"))).status).toBe(403);
    expect(mock.upstream).not.toHaveBeenCalled();
  });

  it("returns only the real canonical 201 original run and rejects a substituted request, wrong status or private-bearing expired result", async () => {
    const body = input(), value = run(body); mock.upstream.mockResolvedValueOnce(Response.json(value, { status: 201 }));
    const actual = await POST(request("runs", body), context("runs")); expect(actual.status).toBe(201); expect(await actual.json()).toEqual(value);
    expect(actual.headers.get("cache-control")).toBe("private, no-store"); expect(actual.headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(mock.upstream.mock.calls[0]).toEqual(["http://api.test/v1/agent-loops/runs", expect.objectContaining({ method: "POST", body: JSON.stringify(body) })]);
    for (const forged of [{ ...value, requestChecksum: "b".repeat(64) }, { ...value, requestId: randomUUID() }, { ...value, privateAvailable: false },
      { ...value, executionContract: { ...contract, checksum: "b".repeat(64) } }, { ...value, extraPrivateBody: "synthetic upstream secret" }]) {
      mock.upstream.mockResolvedValueOnce(Response.json(forged, { status: 201 })); expect((await POST(request("runs", body), context("runs"))).status).toBe(502);
    }
    mock.upstream.mockResolvedValueOnce(Response.json(value)); expect((await POST(request("runs", body), context("runs"))).status).toBe(502);
  });

  it("uses a pure GET original receipt and minimal stop response without requiring a private revision or treating an absent run as stopped", async () => {
    const body = input(), value = run(body), receipt = { version: AGENT_LOOP_VERSION, requestId: body.requestId, requestChecksum: value.requestChecksum,
      disposition: "known", runId: id, status: "stopping", contextAuthority: stamp, privateAvailable: false };
    const query = new URLSearchParams({ requestId: body.requestId, requestChecksum: value.requestChecksum });
    mock.upstream.mockResolvedValueOnce(Response.json(receipt));
    expect((await GET(request("receipts?" + query), context("receipts"))).status).toBe(200);
    expect(mock.upstream.mock.calls[0]![1]?.method).toBe("GET");
    mock.upstream.mockResolvedValueOnce(Response.json(receipt));
    const stop = { version: AGENT_LOOP_VERSION, requestId: body.requestId };
    expect((await POST(request("runs/" + id + "/stop", stop), context("runs", id, "stop"))).status).toBe(200);
    expect(mock.upstream.mock.calls[1]![1]?.body).toBe(JSON.stringify(stop));
    for (const forged of [{ ...receipt, runId: createEntityId() }, { ...receipt, requestId: randomUUID() }, { ...receipt, disposition: "not_found", runId: null, status: null }]) {
      mock.upstream.mockResolvedValueOnce(Response.json(forged)); expect((await POST(request("runs/" + id + "/stop", stop), context("runs", id, "stop"))).status).toBe(502);
    }
  });

  it("fences the complete late response on fresh identity loss and never leaks raw upstream errors or invalid UTF-8", async () => {
    const body = input(), value = run(body); mock.upstream.mockResolvedValueOnce(Response.json(value));
    mock.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    expect((await GET(request("runs/" + id), context("runs", id))).status).toBe(409);
    mock.upstream.mockResolvedValueOnce(Response.json({ code: "authority_changed", message: "synthetic raw private upstream body" }, { status: 409 }));
    const conflict = await GET(request("runs/" + id), context("runs", id)); expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "authority_changed" });
    mock.upstream.mockResolvedValueOnce(Response.json({ message: "synthetic raw private upstream body" }, { status: 500 }));
    const hidden = await GET(request("runs/" + id), context("runs", id)); expect(hidden.status).toBe(502); expect(await hidden.text()).not.toContain("synthetic raw private");
    mock.upstream.mockResolvedValueOnce(new Response(new Uint8Array([0xff]), { status: 200 }));
    expect((await GET(request("runs/" + id), context("runs", id))).status).toBe(502);
  });
});
