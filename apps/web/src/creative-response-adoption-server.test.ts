import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import {
  CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER, CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER,
  CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER, CREATIVE_RESPONSE_ADOPTION_PREVIEW_MAX_BYTES,
  CREATIVE_RESPONSE_ADOPTION_VERSION, type CreativeResponseAdoptionCommand,
  type CreativeResponseAdoptionRequestView, type CreativeResponseAdoptionWorkspace,
} from "@yummyai/contracts/harness/creative-response-adoption";
import { PersonalSessionError } from "./identity/core";
import type * as ErpServer from "./erp-auth/server";

const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>() }));
vi.mock("./server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("./erp-auth/server", async original => ({
  ...(await original<typeof ErpServer>()), erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current,
}));
import { creativeResponseAdoptionProxy, isCreativeResponseAdoptionPath } from "./creative-response-adoption-server";

const executionId = "019f0000-0000-7000-8000-000000000021", otherExecutionId = "019f0000-0000-7000-8000-000000000022";
const adoptionId = "019f0000-0000-7000-8000-000000000023", candidateId = "019f0000-0000-7000-8000-000000000024";
const batchId = "019f0000-0000-7000-8000-000000000025", assetId = "019f0000-0000-7000-8000-000000000026";
const requestId = "11111111-2222-4333-8444-555555555555", otherRequestId = "11111111-2222-4333-8444-666666666666";
const basis = "a".repeat(64), responseChecksum = "b".repeat(64), encryptedChecksum = "c".repeat(64), inputFingerprint = "d".repeat(64);
const privateText = "SYNTHETIC_PRIVATE_RESPONSE_DO_NOT_FORWARD", createdAt = "2026-10-24T12:00:00.000Z";
const image = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cWQAAAAASUVORK5CYII=", "base64"));
const artifactChecksum = createHash("sha256").update(image).digest("hex");
const command: CreativeResponseAdoptionCommand = { requestId, expectedBasis: basis, acknowledgeReviewRequired: true };
const actor: ErpSessionView = {
  authenticated: true, canUseErp: true, userId: "019f0000-0000-7000-8000-000000000011",
  tenantId: "019f0000-0000-7000-8000-000000000012", displayName: "Synthetic operator", organizationName: "Synthetic tenant",
  dataScope: "tenant", permissions: ["design:read", "asset:read"], permissionScopes: { "design:read": "self", "asset:read": "tenant" },
};
const stamp = erpSessionAuthority(actor);
const identity = {
  view: actor, token: "server-only-synthetic-token", sessionId: "server-only-synthetic-session", authority: "synthetic-internal-digest",
  service: { configuration: { apiBase: "https://identity-api.example.test/" } },
} as unknown as ErpServer.ErpRequestIdentity;
const workspacePath = `${executionId}/response-adoption`, previewPath = `${workspacePath}/preview`;
const adoptionPath = `${executionId}/response-adoptions`, lookupPath = `${adoptionPath}/by-request/${requestId}`, cancelPath = `${adoptionPath}/${adoptionId}/cancel`;

function view(status: CreativeResponseAdoptionRequestView["status"] = "prepared"): CreativeResponseAdoptionRequestView {
  return {
    id: adoptionId, executionId, requestId, command: { ...command }, status, attempts: 1, leaseActive: false,
    canRetry: status === "prepared", canCancel: status === "prepared", errorCode: null,
    artifactCleanup: status === "committed" ? "registered" : "not_required", createdAt, updatedAt: createdAt,
    receipt: status === "committed" ? {
      version: CREATIVE_RESPONSE_ADOPTION_VERSION, id: adoptionId, executionId, requestId, basis, candidateId,
      originalPhase: "uncertain", inputFingerprint, responseChecksum, encryptedChecksum,
      artifact: { assetId, version: 1, checksumSha256: artifactChecksum, mediaType: "image/png", width: 1, height: 1 },
      modelKey: "synthetic-image-model", modelVersion: "synthetic-v1", originalCostUsd: null,
      disposition: "generated", rightsStatus: "unverified", approval: "review_required", committedAt: createdAt,
    } : null,
  };
}
function workspace(): CreativeResponseAdoptionWorkspace {
  return {
    version: CREATIVE_RESPONSE_ADOPTION_VERSION, executionId, candidateId, batchId, identityStamp: "9".repeat(64),
    kind: "creative_candidate", stepKey: "generate", originalPhase: "uncertain", candidateStatus: "pending", basis,
    canInspectOriginal: true, canAdopt: true, blockers: [],
    source: {
      inputFingerprint, responseChecksum, encryptedChecksum, archiveState: "registered_unverified", archiveExpiresAt: "2026-10-25T12:00:00.000Z",
      providerRequestId: privateText, receivedAt: createdAt, modelKey: "synthetic-image-model", modelVersion: "synthetic-v1", originalCostUsd: null, providerInvoiceVerified: false,
    }, requests: [], noNewModelCall: true, resultRequiresReview: true,
  };
}
type RequestOptions = { query?: string; authority?: string | null; origin?: string | null; site?: string; raw?: string; headers?: HeadersInit; signal?: AbortSignal };
function request(path: string, method: "GET" | "POST", value?: unknown, options: RequestOptions = {}) {
  const headers = new Headers(options.headers), authority = options.authority === undefined ? stamp : options.authority;
  if (authority !== null) headers.set("x-yummyai-context-authority", authority);
  if (options.site) headers.set("sec-fetch-site", options.site);
  if (method === "POST") {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const origin = options.origin === undefined ? "https://erp.example.test" : options.origin;
    if (origin !== null) headers.set("origin", origin);
  }
  return new Request(`https://erp.example.test/api/creative-executions/${path}${options.query ?? ""}`, {
    method, headers, signal: options.signal, body: method === "POST" ? options.raw ?? (value === undefined ? undefined : JSON.stringify(value)) : undefined,
  });
}
const call = (path = workspacePath, method: "GET" | "POST" = "GET", value?: unknown, options: RequestOptions = {}) =>
  creativeResponseAdoptionProxy(request(path, method, value, options), path, method);
const jsonReply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "x-yummyai-context-authority": stamp } });
function imageHeaders(extra: HeadersInit = {}) {
  const headers = new Headers({ "content-type": "image/png", "x-yummyai-context-authority": stamp,
    [CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER]: basis, [CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER]: responseChecksum,
    [CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER]: artifactChecksum });
  new Headers(extra).forEach((value, key) => headers.set(key, value)); return headers;
}
function heldBody(headers: HeadersInit) {
  let release!: (bytes: Uint8Array) => void;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    release = bytes => { controller.enqueue(bytes); controller.close(); };
  } }), { headers });
  return { response, release: (bytes: Uint8Array) => release(bytes) };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("WEB_AUTH_MODE", "personal"); vi.stubEnv("FACTORY_PORTAL_ONLY", "0");
  vi.stubEnv("WEB_ORIGIN", "https://erp.example.test"); vi.stubEnv("API_BASE_URL", "https://unrelated-process-api.example.test");
  mocks.upstream.mockReset(); mocks.identity.mockReset(); mocks.current.mockReset();
  mocks.identity.mockResolvedValue(identity); mocks.current.mockResolvedValue();
});
afterEach(() => vi.unstubAllEnvs());

describe("original creative-response adoption personal BFF admission", () => {
  it("accepts only fixed v7 execution/adoption routes and exact method pairs before resolving a session", async () => {
    for (const path of [workspacePath, previewPath, adoptionPath, lookupPath, cancelPath]) expect(isCreativeResponseAdoptionPath(path)).toBe(true);
    for (const path of [workspacePath + "/extra", `${executionId}//response-adoption`, `${executionId}/response-adoptions/by-request/not-a-uuid`,
      workspacePath.replace("-7000-", "-4000-"), cancelPath.replace(adoptionId, adoptionId.replace("-7000-", "-4000-")), `../${workspacePath}`]) {
      expect(isCreativeResponseAdoptionPath(path)).toBe(false); expect((await call(path)).status).toBe(404);
    }
    for (const [path, method] of [[workspacePath, "POST"], [previewPath, "POST"], [adoptionPath, "GET"], [lookupPath, "POST"], [cancelPath, "GET"]] as const)
      expect((await call(path, method, command)).status).toBe(404);
    expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("rejects unknown, repeated and noncanonical preview query fields without contacting the service", async () => {
    for (const [path, query] of [[workspacePath, "?basis=" + basis], [previewPath, ""], [previewPath, "?basis=" + basis.toUpperCase()],
      [previewPath, `?basis=${basis}&basis=${basis}`], [previewPath, `?basis=${basis}&extra=1`], [lookupPath, "?after=1"], [adoptionPath, "?basis=" + basis]] as const)
      expect((await call(path, path === adoptionPath ? "POST" : "GET", command, { query })).status).toBe(400);
    expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("requires same-origin writes and rejects explicit cross-site reads without trusting authority alone", async () => {
    for (const options of [{ origin: null }, { origin: "https://other.example.test" }, { site: "cross-site" }])
      expect((await call(adoptionPath, "POST", command, options)).status).toBe(403);
    expect((await call(workspacePath, "GET", undefined, { site: "cross-site" })).status).toBe(403);
    expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("requires the exact current personal authority and both read permission scopes", async () => {
    const changed = erpSessionAuthority({ ...actor, permissionScopes: { ...actor.permissionScopes, "asset:read": "self" } });
    for (const authority of [null, "forged-authority", changed]) {
      const response = await call(workspacePath, "GET", undefined, { authority });
      expect(response.status).toBe(409); expect(await response.json()).toHaveProperty("code", "authority_changed");
    }
    const noAsset: ErpSessionView = { ...actor, permissions: ["design:read"], permissionScopes: { "design:read": "self" } };
    mocks.identity.mockResolvedValueOnce({ ...identity, view: noAsset });
    expect((await call(workspacePath, "GET", undefined, { authority: erpSessionAuthority(noAsset) })).status).toBe(403);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("never falls back to a service actor after a missing session or a pre-dispatch revocation", async () => {
    mocks.identity.mockRejectedValueOnce(new PersonalSessionError(401, "login_required"));
    expect((await call()).status).toBe(401);
    mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    expect((await call()).status).toBe(409); expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("rejects extra, missing or changed command/cancel fields instead of normalizing an unsafe body", async () => {
    for (const value of [{ ...command, requestId: "not-a-uuid" }, { ...command, expectedBasis: basis.toUpperCase() }, { ...command, acknowledgeReviewRequired: false },
      { ...command, approval: "approved" }, { expectedBasis: basis, acknowledgeReviewRequired: true }, {}])
      expect((await call(adoptionPath, "POST", value)).status).toBe(400);
    for (const value of [{ requestId, expectedBasis: basis }, { requestId: "not-a-uuid" }, {}])
      expect((await call(cancelPath, "POST", value)).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it.each([["application/jsonp", "{}", 415], ["application/json", "{", 400], ["application/json", "x".repeat(4097), 413]] as const)(
    "bounds the incoming %s command before service dispatch", async (contentType, raw, status) => {
      const response = await call(adoptionPath, "POST", undefined, { raw, headers: { "content-type": contentType } });
      expect(response.status).toBe(status); expect(mocks.upstream).not.toHaveBeenCalled();
    });
});

describe("original creative-response adoption BFF pinned DTOs", () => {
  it("returns only the strict workspace from the authenticated API origin with private identity-bound headers", async () => {
    mocks.upstream.mockResolvedValueOnce(jsonReply(workspace()));
    const response = await call(); expect(response.status).toBe(200); expect(await response.json()).toEqual(workspace());
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(mocks.upstream).toHaveBeenCalledExactlyOnceWith(`https://identity-api.example.test/v1/creative-executions/${workspacePath}`,
      expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) }));
    const upstreamHeaders = new Headers(mocks.upstream.mock.calls[0]![1]!.headers);
    expect(upstreamHeaders.get("x-yummyai-context-authority")).toBe(stamp); expect(upstreamHeaders.has("authorization")).toBe(false);
    expect(mocks.current).toHaveBeenNthCalledWith(1, identity); expect(mocks.current).toHaveBeenNthCalledWith(2, identity);
  });

  it("keeps prepared and processing noncommitted while returning an original committed receipt unchanged", async () => {
    for (const status of ["prepared", "processing", "committed"] as const) {
      mocks.upstream.mockResolvedValueOnce(jsonReply(view(status), 201));
      const response = await call(adoptionPath, "POST", command), result = await response.json();
      expect(response.status).toBe(200); expect(result).toEqual(view(status));
      expect(result.receipt !== null).toBe(status === "committed");
    }
    expect(mocks.upstream).toHaveBeenCalledTimes(3);
    for (const [, init] of mocks.upstream.mock.calls) expect(JSON.parse(String(init?.body))).toEqual(command);
  });

  it("reads the exact original request and cancels by its fixed adoption and request IDs", async () => {
    mocks.upstream.mockResolvedValueOnce(jsonReply(view()));
    expect(await (await call(lookupPath)).json()).toEqual(view());
    mocks.upstream.mockResolvedValueOnce(jsonReply(view("cancelled")));
    expect(await (await call(cancelPath, "POST", { requestId })).json()).toEqual(view("cancelled"));
    expect(mocks.upstream.mock.calls.map(([url]) => url)).toEqual([
      `https://identity-api.example.test/v1/creative-executions/${lookupPath}`, `https://identity-api.example.test/v1/creative-executions/${cancelPath}`,
    ]);
    expect(JSON.parse(String(mocks.upstream.mock.calls[1]![1]!.body))).toEqual({ requestId });
  });

  it.each(["workspace-execution", "index-execution", "lookup-execution", "lookup-request", "command-request", "command-basis", "cancel-adoption", "cancel-request", "committed-without-receipt", "private-extra"])(
    "rejects mismatched %s instead of returning a plausible success", async variant => {
      let path = lookupPath, method: "GET" | "POST" = "GET", input: unknown, result: unknown = view();
      switch (variant) {
        case "workspace-execution": path = workspacePath; result = { ...workspace(), executionId: otherExecutionId }; break;
        case "index-execution": path = workspacePath; result = { ...workspace(), requests: [{ ...view(), executionId: otherExecutionId }] }; break;
        case "lookup-execution": result = { ...view(), executionId: otherExecutionId }; break;
        case "lookup-request": result = { ...view(), requestId: otherRequestId, command: { ...command, requestId: otherRequestId } }; break;
        case "command-request": path = adoptionPath; method = "POST"; input = command; result = { ...view(), requestId: otherRequestId, command: { ...command, requestId: otherRequestId } }; break;
        case "command-basis": path = adoptionPath; method = "POST"; input = command; result = { ...view(), command: { ...command, expectedBasis: encryptedChecksum } }; break;
        case "cancel-adoption": path = cancelPath; method = "POST"; input = { requestId }; result = { ...view("cancelled"), id: candidateId }; break;
        case "cancel-request": path = cancelPath; method = "POST"; input = { requestId }; result = { ...view("cancelled"), requestId: otherRequestId, command: { ...command, requestId: otherRequestId } }; break;
        case "committed-without-receipt": result = { ...view(), status: "committed" }; break;
        case "private-extra": result = { ...view(), rawProviderCredential: privateText }; break;
      }
      mocks.upstream.mockResolvedValueOnce(jsonReply(result));
      const response = await call(path, method, input); expect(response.status).toBe(502);
      const body = await response.text(); expect(body).not.toContain(privateText); expect(body).not.toContain(otherExecutionId); expect(body).not.toContain(otherRequestId);
    });

  it("cancels an upstream success with another authority before reading its private body", async () => {
    const pull = vi.fn(), cancel = vi.fn();
    mocks.upstream.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { "content-type": "application/json", "x-yummyai-context-authority": "other-owner" },
    }));
    const response = await call(); expect(response.status).toBe(409); expect(await response.json()).toHaveProperty("code", "authority_changed");
    expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("bounds upstream metadata with declared=%s and cancels without returning partial data", async declared => {
    const pull = vi.fn(), cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pull(); controller.enqueue(new TextEncoder().encode(privateText + "x".repeat(128 * 1024))); }, cancel }, { highWaterMark: 0 });
    mocks.upstream.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "application/json", "x-yummyai-context-authority": stamp,
      ...(declared ? { "content-length": String(128 * 1024 + 1) } : {}) } }));
    const response = await call(); expect(response.status).toBe(413); expect(await response.text()).not.toContain(privateText);
    expect(cancel).toHaveBeenCalledTimes(1); expect(pull).toHaveBeenCalledTimes(declared ? 0 : 1);
  });
});

describe("original creative-response preview bytes and live identity", () => {
  it("binds all three pins and actual image SHA without confusing the JSON checksum with the image checksum", async () => {
    expect(artifactChecksum).not.toBe(responseChecksum);
    mocks.upstream.mockResolvedValueOnce(new Response(image, { headers: imageHeaders({ "content-length": String(image.byteLength) }) }));
    const response = await call(previewPath, "GET", undefined, { query: `?basis=${basis}` });
    expect(response.status).toBe(200); expect(response.headers.get(CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER)).toBe(basis);
    expect(response.headers.get(CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER)).toBe(responseChecksum);
    expect(response.headers.get(CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER)).toBe(artifactChecksum);
    expect(response.headers.get("x-yummyai-context-authority")).toBe(stamp); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.get("content-length")).toBe(String(image.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(image); expect(mocks.current).toHaveBeenCalledTimes(2);
    expect(mocks.upstream.mock.calls[0]![0]).toBe(`https://identity-api.example.test/v1/creative-executions/${previewPath}?basis=${basis}`);
  });

  it.each([CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER, CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER, CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER, "content-type"])(
    "cancels unread image bytes when preview header %s is invalid", async field => {
      const headers = imageHeaders(), pull = vi.fn(), cancel = vi.fn(); headers.set(field, field === "content-type" ? "image/svg+xml" : "not-a-fixed-hash");
      mocks.upstream.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), { headers }));
      const response = await call(previewPath, "GET", undefined, { query: `?basis=${basis}` });
      expect(response.status).toBe(502); expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
    });

  it.each(["oversize-declared", "oversize-streamed", "truncated", "bad-image-sha", "empty"])("rejects %s original image without emitting image bytes", async variant => {
    const headers = imageHeaders(); let bytes: Uint8Array = image; const cancel = vi.fn(), pull = vi.fn();
    if (variant === "oversize-declared") headers.set("content-length", String(CREATIVE_RESPONSE_ADOPTION_PREVIEW_MAX_BYTES + 1));
    if (variant === "oversize-streamed") bytes = new Uint8Array(CREATIVE_RESPONSE_ADOPTION_PREVIEW_MAX_BYTES + 1);
    if (variant === "truncated") headers.set("content-length", String(image.byteLength + 1));
    if (variant === "bad-image-sha") headers.set(CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER, "0".repeat(64));
    if (variant === "empty") bytes = new Uint8Array();
    const source = new ReadableStream<Uint8Array>({ pull(controller) { pull(); if (bytes.byteLength) controller.enqueue(bytes); if (!variant.startsWith("oversize")) controller.close(); }, cancel }, { highWaterMark: 0 });
    mocks.upstream.mockResolvedValueOnce(new Response(source, { headers }));
    const response = await call(previewPath, "GET", undefined, { query: `?basis=${basis}` });
    expect(response.status).toBe(502); expect(response.headers.get("content-type")).toContain("application/json"); expect(response.headers.has(CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER)).toBe(false);
    if (variant.startsWith("oversize")) { expect(cancel).toHaveBeenCalledTimes(1); expect(pull).toHaveBeenCalledTimes(variant === "oversize-declared" ? 0 : 1); }
  });

  it.each(["json-logout", "json-revoked", "image-logout", "image-revoked"])("withholds the fully delayed private %s body after current membership changes", async variant => {
    const isImage = variant.startsWith("image"), logout = variant.endsWith("logout");
    const source = heldBody(isImage ? imageHeaders() : { "content-type": "application/json", "x-yummyai-context-authority": stamp });
    mocks.upstream.mockResolvedValueOnce(source.response);
    const pending = call(isImage ? previewPath : workspacePath, "GET", undefined, isImage ? { query: `?basis=${basis}` } : {});
    await vi.waitFor(() => expect(mocks.upstream).toHaveBeenCalledTimes(1)); expect(mocks.current).toHaveBeenCalledTimes(1);
    mocks.current.mockRejectedValueOnce(logout ? new PersonalSessionError(401, "login_required") : new PersonalSessionError(409, "authority_changed"));
    source.release(isImage ? image : new TextEncoder().encode(JSON.stringify(workspace())));
    const response = await pending; expect(response.status).toBe(logout ? 401 : 409);
    expect(response.headers.get("content-type")).toContain("application/json"); expect(response.headers.has(CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER)).toBe(false);
    const body = await response.text(); expect(body).not.toContain(privateText); expect(body).not.toContain(responseChecksum); expect(body).not.toContain(candidateId);
    expect(mocks.current).toHaveBeenCalledTimes(2); expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });

  it("returns only an allowlisted short409 code and drops arbitrary raw diagnostics", async () => {
    for (const code of ["CREATIVE_ADOPTION_BASIS_CHANGED", "authority_changed", privateText]) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: privateText, raw: { token: privateText }, stack: privateText }, { status: 409 }));
      const response = await call(), body = await response.json(); expect(response.status).toBe(409);
      expect(body.code).toBe(code === privateText ? undefined : code); expect(JSON.stringify(body)).not.toContain(privateText);
      expect(Object.keys(body).every(key => ["error", "code"].includes(key))).toBe(true);
    }
    expect(mocks.upstream).toHaveBeenCalledTimes(3);
  });

  it("rechecks membership after a held failure body before exposing even its public code", async () => {
    const source = heldBody({ "content-type": "application/json" });
    mocks.upstream.mockResolvedValueOnce(new Response(source.response.body, { status: 409, headers: { "content-type": "application/json" } }));
    const pending = call(); await vi.waitFor(() => expect(mocks.upstream).toHaveBeenCalledTimes(1));
    mocks.current.mockRejectedValueOnce(new PersonalSessionError(401, "login_required"));
    source.release(new TextEncoder().encode(JSON.stringify({ code: "CREATIVE_ADOPTION_BASIS_CHANGED", raw: privateText })));
    const response = await pending; expect(response.status).toBe(401); const body = await response.text();
    expect(body).toContain("login_required"); expect(body).not.toContain("CREATIVE_ADOPTION_BASIS_CHANGED"); expect(body).not.toContain(privateText);
  });
});
