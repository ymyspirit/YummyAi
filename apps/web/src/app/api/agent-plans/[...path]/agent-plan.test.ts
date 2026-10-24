import { createHash, randomUUID } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_PLAN_VERSION, CreateAgentPlanSchema, defaultAgentPlanLimits, type AgentPlanView } from "@yummyai/contracts/ai/agent-plan";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";

const mock = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mock.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mock.identity, assertErpIdentityCurrent: mock.current, erpAuthFailure: mock.failure }));
import { GET, POST } from "./route";

const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), displayName: "Synthetic operator",
  organizationName: "Synthetic tenant", permissions: ["workflow:read", "workflow:run"], permissionScopes: { "workflow:read": "self", "workflow:run": "self" }, dataScope: "self" };
const authority = erpSessionAuthority(actor), origin = "http://web.test", id = createEntityId(), itemId = createEntityId(), checksum = "a".repeat(64), time = "2026-10-22T00:00:00.000Z";
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const input = () => CreateAgentPlanSchema.parse({ version: AGENT_PLAN_VERSION, requestId: randomUUID(), goal: "Synthetic bounded original command planning", contextText: "Synthetic unverified facts",
  modelId: createEntityId(), allowedReads: ["inventory.balances.page"], allowedCommands: [{ domain: "procurement", kind: "requisition_create" }], limits: defaultAgentPlanLimits(), maxCostUsd: 0.1,
  executionContract: { contractVersion: "native-harness-v1", executorKey: "erp.agent.plan", skill: { key: "erp.agent.plan", version: AGENT_PLAN_VERSION, checksum }, tools: [{ key: "agent.plan.decide", version: AGENT_PLAN_VERSION, checksum }], checksum } });
const run = (body = input()): AgentPlanView => ({ version: AGENT_PLAN_VERSION, id, requestId: body.requestId, requestChecksum: sha(body), contextAuthority: authority,
  revision: 1, status: "queued", goal: body.goal, contextText: body.contextText, modelLabel: "Synthetic priced model", allowedReads: body.allowedReads, allowedCommands: body.allowedCommands,
  executionContract: body.executionContract, limits: body.limits, cost: { capUsd: "0.100000", knownCostUsd: "0.000000", reservedUsd: "0.100000", coverage: "known", modelTurns: 0 },
  toolCalls: 0, observedRows: 0, stopRequestedAt: null, errorCode: null, createdAt: time, updatedAt: time, deadlineAt: "2026-10-22T00:10:00.000Z", expiresAt: "2026-10-23T00:00:00.000Z",
  privateAvailable: true, stepsComplete: true, steps: [], collections: [], result: null, items: [], verification: "pending", businessExecution: "separate_original_confirmation" });
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (path: string, body?: unknown, stamp: string | null = authority, otherOrigin = origin) => new Request(origin + "/api/agent-plans/" + path,
  { method: body === undefined ? "GET" : "POST", headers: { origin: otherOrigin, "content-type": "application/json", ...(stamp ? { "x-yummyai-context-authority": stamp } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const upstream = (value: unknown, status = 200) => Response.json(value, { status, headers: { "x-yummyai-context-authority": authority } });

describe("strict personal model-planning BFF", () => {
  beforeEach(() => { vi.clearAllMocks(); mock.upstream.mockReset(); mock.identity.mockResolvedValue({ view: actor }); mock.current.mockResolvedValue();
    mock.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); process.env.API_BASE_URL = "http://api.test"; });

  it("allows only strict stamped planning and explicit item-preparation routes without exposing automatic business execution", async () => {
    const body = input();
    for (const [path, value] of [["runs", { ...body, tenantId: actor.tenantId }], ["runs", { ...body, autoConfirm: true }],
      [`runs/${id}/execute`, {}], [`runs/${id}/items/${itemId}/confirm`, {}], [`runs/${id}/items/${itemId}/prepare`, { version: AGENT_PLAN_VERSION, requestId: body.requestId, proposalChecksum: checksum, original: {} }]] as const)
      expect([400, 404]).toContain((await POST(request(path, value), context(...path.split("/")))).status);
    expect((await POST(request("runs", body, null), context("runs"))).status).toBe(409);
    expect((await POST(request("runs", body, authority, "http://other.test"), context("runs"))).status).toBe(403);
    expect((await GET(request("workspace?tenantId=caller"), context("workspace"))).status).toBe(400);
    const readOnly = { ...actor, permissions: ["workflow:read"] }; mock.identity.mockResolvedValueOnce({ view: readOnly });
    expect((await POST(request("runs", body, erpSessionAuthority(readOnly)), context("runs"))).status).toBe(403); expect(mock.upstream).not.toHaveBeenCalled();
  });

  it("accepts actual201 only for canonical original planning and never adopts a different request allowed command set or fabricated private view", async () => {
    const body = input(), value = run(body); mock.upstream.mockResolvedValueOnce(upstream(value, 201));
    const response = await POST(request("runs", body), context("runs")); expect(response.status).toBe(201); expect(await response.json()).toEqual(value);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("x-yummyai-context-authority")).toBe(authority);
    for (const changed of [{ ...value, requestId: randomUUID() }, { ...value, requestChecksum: "f".repeat(64) },
      { ...value, allowedCommands: [{ domain: "finance", kind: "bill_record" }] }, { ...value, privateAvailable: false }]) {
      mock.upstream.mockResolvedValueOnce(upstream(changed, 201)); expect((await POST(request("runs", body), context("runs"))).status).toBe(502);
    }
    mock.upstream.mockResolvedValueOnce(upstream(value, 200)); expect((await POST(request("runs", body), context("runs"))).status).toBe(502);
  });

  it("binds explicit prepare201 and pure GET item receipts to the parent item and proposal proof without treating a coordinator-only unknown as prepared", async () => {
    const body = { version: AGENT_PLAN_VERSION, requestId: randomUUID(), proposalChecksum: checksum }, path = ["runs", id, "items", itemId];
    const value = { version: AGENT_PLAN_VERSION, runId: id, itemId, proposalChecksum: checksum, preparationRequestChecksum: checksum,
      disposition: "known", agentCommandId: createEntityId(), ownerCommandId: createEntityId(), contextAuthority: authority };
    mock.upstream.mockResolvedValueOnce(upstream(value, 201)); expect((await POST(request(path.join("/") + "/prepare", body), context(...path, "prepare"))).status).toBe(201);
    const query = new URLSearchParams({ requestId: body.requestId, proposalChecksum: checksum });
    mock.upstream.mockResolvedValueOnce(upstream(value)); expect((await GET(request(path.join("/") + "/receipt?" + query), context(...path, "receipt"))).status).toBe(200);
    for (const changed of [{ ...value, itemId: createEntityId() }, { ...value, runId: createEntityId() }, { ...value, proposalChecksum: "f".repeat(64) }]) {
      mock.upstream.mockResolvedValueOnce(upstream(changed)); expect((await GET(request(path.join("/") + "/receipt?" + query), context(...path, "receipt"))).status).toBe(502);
    }
    mock.upstream.mockResolvedValueOnce(upstream({ ...value, disposition: "unknown", agentCommandId: null, ownerCommandId: null }));
    expect((await GET(request(path.join("/") + "/receipt?" + query), context(...path, "receipt"))).status).toBe(200);
    expect(mock.upstream.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("recovers and stops only original IDs with exact200 proof while masking native errors and never retrying a lost prepare response", async () => {
    const body = input(), proof = { requestId: body.requestId, requestChecksum: sha(body) }, value = { version: AGENT_PLAN_VERSION, ...proof, disposition: "known", runId: id, status: "stopping", contextAuthority: authority, privateAvailable: false };
    const query = "receipts?" + new URLSearchParams(proof);
    mock.upstream.mockResolvedValueOnce(upstream(value)); expect((await GET(request(query), context("receipts"))).status).toBe(200);
    mock.upstream.mockResolvedValueOnce(upstream({ ...value, requestChecksum: "f".repeat(64) })); expect((await GET(request(query), context("receipts"))).status).toBe(502);
    mock.upstream.mockResolvedValueOnce(upstream(value)); expect((await POST(request(`runs/${id}/stop`, { version: AGENT_PLAN_VERSION, requestId: body.requestId }), context("runs", id, "stop"))).status).toBe(200);
    mock.upstream.mockRejectedValueOnce(new TypeError("synthetic lost native prepare201"));
    expect((await POST(request(`runs/${id}/items/${itemId}/prepare`, { version: AGENT_PLAN_VERSION, requestId: body.requestId, proposalChecksum: checksum }), context("runs", id, "items", itemId, "prepare"))).status).toBe(502);
    expect(mock.upstream).toHaveBeenCalledTimes(4);
    mock.upstream.mockResolvedValueOnce(upstream({ message: "synthetic private SQL text" }, 409));
    const denied = await GET(request(query), context("receipts")); expect(denied.status).toBe(409); expect(await denied.text()).not.toContain("synthetic private SQL text");
  });

  it("rechecks identity after the full private body and rejects invalid UTF8 before returning a late planning result", async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; }), body = run();
    const stream = new ReadableStream<Uint8Array>({ async start(controller) { await gate; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); } });
    mock.upstream.mockResolvedValueOnce(new Response(stream)); const pending = GET(request("runs/" + id), context("runs", id));
    await vi.waitFor(() => expect(mock.upstream).toHaveBeenCalledTimes(1)); expect(mock.current).not.toHaveBeenCalled();
    mock.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed")); release();
    const actual = await pending; expect(actual.status).toBe(409); expect(await actual.text()).not.toContain(body.goal!);
    mock.current.mockResolvedValue(); mock.upstream.mockResolvedValueOnce(new Response(new Uint8Array([0xff])));
    expect((await GET(request("runs/" + id), context("runs", id))).status).toBe(502);
  });
});
