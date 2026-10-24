import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { PersonalSessionError } from "../../../../../../identity/core";
import { executionActor, executionAuthority, executionIds, executionInput, executionReceipt, executionResponse, executionView, executionWorkspace } from "../../../../../../features/marketplaces/store-node-execution.test-fixture";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), upstream: vi.fn<typeof fetch>(), current: vi.fn<() => Promise<void>>() }));
vi.mock("../../../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current,
  erpAuthFailure: (error: PersonalSessionError) => Response.json({ code: error.code, message: "当前本人权限需重新核对" }, { status: error.status, headers: { "cache-control": "private, no-store" } }) }));
import { GET, POST } from "./route";

const origin = "http://localhost:3130", base = `${origin}/api/marketplace-accounts/${executionIds.account}/node-executions`;
const context = (...path: string[]) => ({ params: Promise.resolve({ id: executionIds.account, path }) });
function request(path = "", body?: unknown, authority: string | null = executionAuthority, from: string | null = origin) {
  const headers = new Headers(authority === null ? undefined : { "x-yummyai-context-authority": authority });
  if (body !== undefined) { headers.set("content-type", "application/json"); if (from !== null) headers.set("origin", from); }
  return new Request(base + path, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const query = () => ({ requestId: executionIds.request, requestChecksum: executionInput().requestChecksum });
beforeEach(() => { vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130"); mocks.upstream.mockReset(); mocks.identity.mockReset().mockResolvedValue({ view: executionActor, authority: executionAuthority }); mocks.current.mockReset().mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllEnvs());
describe("personal store node execution BFF", () => {
  it("rejects unknown methods, paths, queries, extra fields and foreign origins without forwarding", async () => {
    expect((await GET(request("/receipt"), context("receipt"))).status).toBe(400);
    expect((await POST(request("/history", {}), context("history"))).status).toBe(400);
    expect((await GET(request("/history?before=x&before=y"), context("history"))).status).toBe(400);
    expect((await GET(request("?nodeId=x"), context())).status).toBe(400);
    expect((await POST(request("", executionInput(), executionAuthority, "https://other.synthetic.test"), context())).status).toBe(403);
    expect((await POST(request("", { ...executionInput(), secret: "synthetic forbidden field" }), context())).status).toBe(400);
    expect((await POST(request("", { ...executionInput(), requestChecksum: "f".repeat(64) }), context())).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("keeps receipt POST read-only while new tasks require Manage but never require StoreAuthorize", async () => {
    const reader = { ...executionActor, permissions: ["store:read"] as typeof executionActor.permissions }, authority = createHash("sha256").update(erpSessionAuthority(reader)).digest("hex");
    mocks.identity.mockResolvedValue({ view: reader, authority });
    expect((await POST(request("", executionInput(), authority), context())).status).toBe(403);
    mocks.upstream.mockResolvedValueOnce(Response.json(executionReceipt()));
    const restored = await POST(request("/receipt", query(), authority), context("receipt"));
    expect(restored.status).toBe(200); expect(restored.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
    expect(mocks.upstream.mock.calls[0]![0]).toBe(`http://127.0.0.1:8130/v1/marketplace-accounts/${executionIds.account}/node-executions/receipt`);
    mocks.identity.mockResolvedValue({ view: executionActor, authority: executionAuthority }); mocks.upstream.mockResolvedValueOnce(executionResponse(executionView(), 201));
    expect((await POST(request("", executionInput()), context())).status).toBe(201);
    const count = mocks.upstream.mock.calls.length;
    expect((await GET(request("", undefined, null), context())).status).toBe(409); expect(mocks.upstream).toHaveBeenCalledTimes(count);
  });
  it("binds saved task and original snapshot to the exact submitted tuple and rejects substituted receipts", async () => {
    mocks.upstream.mockResolvedValueOnce(executionResponse(executionView(true), 201));
    const saved = await POST(request("", executionInput()), context()); expect(saved.status).toBe(201);
    expect(saved.headers.get("cache-control")).toBe("private, no-store");
    expect((await saved.json() as { snapshot: { version: number } }).snapshot.version).toBe(7);
    const wrong = executionView(); wrong.input.ttlHours = 48; mocks.upstream.mockResolvedValueOnce(executionResponse(wrong, 201));
    expect((await POST(request("", executionInput()), context())).status).toBe(502);
    const wrongReceipt = executionReceipt(); wrongReceipt.accountId = executionIds.other; mocks.upstream.mockResolvedValueOnce(executionResponse(wrongReceipt));
    expect((await POST(request("/receipt", query()), context("receipt"))).status).toBe(502);
    const wrongActor = executionWorkspace(); wrongActor.context.actorId = executionIds.other; mocks.upstream.mockResolvedValueOnce(executionResponse(wrongActor));
    expect((await GET(request(), context())).status).toBe(409);
  });
  it("rejects malformed pagination, preserves only safe codes, and discards a late task after current identity changes", async () => {
    mocks.upstream.mockResolvedValueOnce(executionResponse({ protocol: "erp-store-node-execution-v1", accountId: executionIds.account, items: [], nextCursor: executionIds.execution, hasMore: true }));
    expect((await GET(request("/history"), context("history"))).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(executionResponse({ code: "store_node_upstream_rate_limited", privateDiagnostic: "synthetic raw error text" }, 503));
    const failure = await GET(request(), context()); const text = await failure.text();
    expect(failure.status).toBe(503); expect(text).toContain("store_node_upstream_rate_limited"); expect(text).not.toContain("synthetic raw error text");
    mocks.upstream.mockResolvedValueOnce(executionResponse(executionView(true)));
    mocks.current.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const late = await GET(request(`/${executionIds.execution}`), context(executionIds.execution));
    expect(late.status).toBe(409); expect(await late.text()).not.toContain("original capability result");
  });
});
