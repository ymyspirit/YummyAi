import { createHash, randomUUID } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandOriginal, canonicalAgentCommandRequest, PrepareAgentCommandSchema } from "@yummyai/contracts/ai/agent-command";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";

const mock = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mock.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mock.identity, assertErpIdentityCurrent: mock.current, erpAuthFailure: mock.failure }));
import { GET, POST } from "./route";

const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(),
  displayName: "Synthetic operator", organizationName: "Synthetic tenant", permissions: ["workflow:read", "workflow:run"],
  permissionScopes: { "workflow:read": "self", "workflow:run": "self" }, dataScope: "self" };
const authority = erpSessionAuthority(actor), origin = "http://web.test", id = createEntityId(), ownerId = createEntityId(), date = "2026-10-22T00:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const input = () => PrepareAgentCommandSchema.parse({ version: AGENT_COMMAND_VERSION, requestId: randomUUID(), original: { domain: "procurement",
  command: { kind: "requisition_create", targetId: null, input: { code: "SYNTHETIC", reasonCode: "SYNTHETIC", lines: [{ lineKey: "L1",
    stockItemId: createEntityId(), destinationLocationId: createEntityId(), quantity: 2, unit: "each" }], idempotencyKey: randomUUID() } } } });
const view = (body = input(), operation: "prepare" | "adopt" = "prepare", adopted?: unknown) => ({ version: AGENT_COMMAND_VERSION, id, requestId: body.requestId,
  requestChecksum: sha(canonicalAgentCommandRequest(operation, adopted ?? body)), contextAuthority: authority, domain: "procurement", kind: "requisition_create",
  ownerCommandId: ownerId, createdAt: date, expiresAt: "2026-10-29T00:00:00.000Z", executeRequestedAt: null, cancelledAt: null, state: "prepared",
  privateAvailable: true, snapshot: { reference: { domain: "procurement", commandId: ownerId, accountId: null }, original: body.original,
    native: { domain: "procurement", view: { id: ownerId, kind: "requisition_create", targetId: null, targetLabel: "Synthetic requisition", targetDetail: null,
      status: "prepared", createdAt: date, expiresAt: "2026-10-29T00:00:00.000Z", completedAt: null, contextAuthority: authority,
      acknowledged: false, canExecute: true, canCancel: true, original: body.original.command, result: null, blockReason: null } } },
  originalChecksum: sha(canonicalAgentCommandOriginal(body.original)), confirmationToken: "synthetic-encrypted-short-lived-token",
  confirmationExpiresAt: "2026-10-22T00:05:00.000Z", canConfirm: true, canCancel: true, errorCode: null });
const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (path: string, body?: unknown, stamp: string | null = authority, otherOrigin = origin) => new Request(origin + "/api/agent-commands/" + path,
  { method: body === undefined ? "GET" : "POST", headers: { origin: otherOrigin, "content-type": "application/json",
    ...(stamp ? { "x-yummyai-context-authority": stamp } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("native Agent command personal BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mock.upstream.mockReset(); mock.identity.mockResolvedValue({ view: actor }); mock.current.mockResolvedValue();
    mock.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status }));
    process.env.API_BASE_URL = "http://api.test";
  });
  it("allows only personal stamped strict original-owner routes and explicit actions without dynamic tools or selected identities", async () => {
    const body = input();
    for (const [path, changed] of [["prepare", { ...body, autoConfirm: true }], ["prepare", { ...body, tenantId: actor.tenantId }],
      ["requests/" + id + "/execute", {}], ["requests/" + id + "/confirm", { version: AGENT_COMMAND_VERSION, requestId: body.requestId }]] as const)
      expect([400, 404]).toContain((await POST(request(path, changed), ctx(...path.split("/")))).status);
    expect((await POST(request("prepare", body, null), ctx("prepare"))).status).toBe(409);
    expect((await POST(request("prepare", body, authority, "http://other.test"), ctx("prepare"))).status).toBe(403);
    expect((await GET(request("workspace?tenantId=other"), ctx("workspace"))).status).toBe(400);
    expect((await GET(request("receipts?requestId=" + body.requestId + "&requestId=" + body.requestId + "&requestChecksum=" + "a".repeat(64)), ctx("receipts"))).status).toBe(400);
    const readOnly = { ...actor, permissions: ["workflow:read"] }; mock.identity.mockResolvedValueOnce({ view: readOnly });
    expect((await POST(request("prepare", body, erpSessionAuthority(readOnly)), ctx("prepare"))).status).toBe(403);
    expect(mock.upstream).not.toHaveBeenCalled();
  });
  it("accepts only actual201 prepare or adoption receipts with the original owner SHA and refuses substituted private originals", async () => {
    const body = input(), value = view(body); mock.upstream.mockResolvedValueOnce(Response.json(value, { status: 201 }));
    const actual = await POST(request("prepare", body), ctx("prepare")); expect(actual.status).toBe(201); expect(await actual.json()).toEqual(value);
    expect(actual.headers.get("cache-control")).toBe("private, no-store"); expect(actual.headers.get("x-yummyai-context-authority")).toBe(authority);
    for (const changed of [{ ...value, requestChecksum: "b".repeat(64) }, { ...value, requestId: randomUUID() }, { ...value, originalChecksum: "b".repeat(64) },
      { ...value, confirmationToken: null }, { ...value, extraPrivate: "synthetic-private" }]) {
      mock.upstream.mockResolvedValueOnce(Response.json(changed, { status: 201 })); expect((await POST(request("prepare", body), ctx("prepare"))).status).toBe(502);
    }
    const adopt = { version: AGENT_COMMAND_VERSION, requestId: body.requestId, reference: { domain: "procurement", commandId: ownerId, accountId: null } };
    mock.upstream.mockResolvedValueOnce(Response.json(view(body, "adopt", adopt), { status: 201 }));
    expect((await POST(request("adopt", adopt), ctx("adopt"))).status).toBe(201);
    mock.upstream.mockResolvedValueOnce(Response.json(value, { status: 200 })); expect((await POST(request("prepare", body), ctx("prepare"))).status).toBe(502);
  });
  it("recovers only by GET with the exact request proof and masks native errors instead of inventing a successful execution", async () => {
    const body = input(), query = { requestId: body.requestId, requestChecksum: view(body).requestChecksum };
    const receipt = { version: AGENT_COMMAND_VERSION, ...query, disposition: "known", id, ownerCommandId: ownerId, privateAvailable: false, contextAuthority: authority };
    const path = "receipts?" + new URLSearchParams(query);
    mock.upstream.mockResolvedValueOnce(Response.json(receipt)); expect((await GET(request(path), ctx("receipts"))).status).toBe(200);
    expect(mock.upstream.mock.calls[0]?.[1]?.method).toBe("GET");
    mock.upstream.mockResolvedValueOnce(Response.json({ ...receipt, requestChecksum: "f".repeat(64) })); expect((await GET(request(path), ctx("receipts"))).status).toBe(502);
    mock.upstream.mockResolvedValueOnce(Response.json({ message: "synthetic private SQL secret" }, { status: 409 }));
    const denied = await GET(request(path), ctx("receipts")); expect(denied.status).toBe(409); expect(await denied.text()).not.toContain("synthetic private SQL secret");
    mock.upstream.mockResolvedValueOnce(Response.json({ code: "authority_changed", message: "private" }, { status: 409 }));
    expect(await (await GET(request(path), ctx("receipts"))).json()).toHaveProperty("code", "authority_changed");
    expect(mock.upstream.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("requires actual200 action results bound to the submitted request and owner rather than treating an unknown response as success", async () => {
    const body = input(), value = view(body), confirm = { version: AGENT_COMMAND_VERSION, requestId: body.requestId, ownerCommandId: ownerId,
      originalChecksum: value.originalChecksum, confirmationToken: value.confirmationToken, decision: "execute_original" };
    const path = ["requests", id, "confirm"];
    mock.upstream.mockResolvedValueOnce(Response.json(value)); expect((await POST(request(path.join("/"), confirm), ctx(...path))).status).toBe(200);
    expect(JSON.parse(String(mock.upstream.mock.calls[0]?.[1]?.body))).toEqual(confirm);
    mock.upstream.mockResolvedValueOnce(Response.json({ ...value, requestId: randomUUID() })); expect((await POST(request(path.join("/"), confirm), ctx(...path))).status).toBe(502);
    mock.upstream.mockRejectedValueOnce(new TypeError("synthetic response lost after native commit"));
    expect((await POST(request(path.join("/"), confirm), ctx(...path))).status).toBe(502); expect(mock.upstream).toHaveBeenCalledTimes(3);
  });
  it("rechecks identity after the complete response body and rejects invalid UTF8 or a changed authority before returning any private preview", async () => {
    const body = input(); let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const stream = new ReadableStream<Uint8Array>({ async start(controller) { await gate; controller.enqueue(new TextEncoder().encode(JSON.stringify(view(body)))); controller.close(); } });
    mock.upstream.mockResolvedValueOnce(new Response(stream)); const pending = GET(request("requests/" + id), ctx("requests", id));
    await vi.waitFor(() => expect(mock.upstream).toHaveBeenCalledTimes(1));
    expect(mock.current).not.toHaveBeenCalled(); mock.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed")); release();
    const actual = await pending; expect(actual.status).toBe(409); expect(await actual.text()).not.toContain("Synthetic requisition");
    mock.current.mockResolvedValue(); mock.upstream.mockResolvedValueOnce(new Response(new Uint8Array([0xff]), { status: 200 }));
    expect((await GET(request("requests/" + id), ctx("requests", id))).status).toBe(502);
    mock.upstream.mockResolvedValueOnce(Response.json({ ...view(body), contextAuthority: "other" }));
    expect((await GET(request("requests/" + id), ctx("requests", id))).status).toBe(409);
  });
});
