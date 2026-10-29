import { createHash, randomUUID } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { AssistViewSchema, CreateAssistSchema, type AssistHistoryEntry } from "@yummyai/contracts/ai/assist";
import { AssistAutomaticAuditReuseProofSchema, assistRequestRecoveryText } from "@yummyai/contracts/ai/assist-recovery";
import { ARTWORK_AUDIT_POLICY, ArtworkAuditCodeSchema, ArtworkAuditReportSchema } from "@yummyai/contracts/ai/artwork-audit";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";

const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(),
  displayName: "Synthetic recovery reader", organizationName: "Synthetic personal tenant", dataScope: "tenant",
  permissions: ["workflow:read", "workflow:run", "order:read", "order:pii:read", "order:write"],
  permissionScopes: { "workflow:read": "tenant", "workflow:run": "tenant", "order:read": "tenant", "order:pii:read": "tenant", "order:write": "tenant" } };
const authority = erpSessionAuthority(actor), origin = "http://web.test";
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const request = () => CreateAssistSchema.options[0].parse({ kind: "knowledge_answer", scopeId: randomUUID(), requestId: randomUUID(), modelId: createEntityId(),
  search: { query: "Synthetic original question", topic: "operations", platform: "all", market: "ALL", spuIds: [] } });
function view(input = request()) {
  return AssistViewSchema.parse({ id: createEntityId(), kind: input.kind, scope: `knowledge:${input.scopeId}`, status: "queued", createdAt: "2026-10-22T00:00:00.000Z",
    completedAt: null, modelLabel: "Synthetic model", model: "synthetic", promptVersion: "original-v1", inputFingerprint: "a".repeat(64),
    stale: false, maxTaskCostUsd: 1, request: input, inputTokens: null, outputTokens: null, costUsd: null, error: null, diagnostics: [], sources: [], checks: [], result: null });
}
const post = (body: string, requestOrigin = origin) => new Request(origin + "/api/ai-assists/runs", { method: "POST",
  headers: { origin: requestOrigin, "content-type": "application/json", authorization: "browser-supplied", "x-yummyai-context-authority": authority }, body });
const checksum = (input: ReturnType<typeof request>) => createHash("sha256").update(assistRequestRecoveryText(input)).digest("hex");
const receipt = (input: ReturnType<typeof request>, run: ReturnType<typeof view> | null) => ({ version: "assist-request-receipt-v1", contextAuthority: authority,
  requestId: input.requestId, requestChecksum: checksum(input), state: run ? "found" : "not_found", run });

// Metadata-only transport fixture: no image or production approval is fabricated.
function auditMetadata() {
  const original = CreateAssistSchema.options[3].parse({ kind: "artwork_preflight", orderLineId: createEntityId(), expectedRevision: 2,
    expectedEditorVersionId: createEntityId(), modelId: createEntityId(), requestId: randomUUID(), automaticAudit: true });
  const submitted = { ...original, requestId: randomUUID() };
  const audit = ArtworkAuditReportSchema.parse({ policy: ARTWORK_AUDIT_POLICY, orderLineId: original.orderLineId, revision: 2,
    projectId: createEntityId(), versionId: original.expectedEditorVersionId, versionNumber: 1, documentHash: "a".repeat(64),
    sourceVersionId: null, factoryStandardId: null, ruleBasis: "Synthetic transport metadata only", complete: false,
    checks: ArtworkAuditCodeSchema.options.map(code => ({ code, title: code, status: "needs_review", method: "measurement",
      detail: "Synthetic transport check No artifact was produced", action: "", evidence: [], marks: [] })) });
  const saved = AssistViewSchema.parse({ ...view(), kind: original.kind, scope: `order:${original.orderLineId}`, request: original, artworkAudit: audit });
  const sha = (input: Parameters<typeof assistRequestRecoveryText>[0]) => createHash("sha256").update(assistRequestRecoveryText(input)).digest("hex");
  const proof = AssistAutomaticAuditReuseProofSchema.parse({ version: "assist-automatic-audit-reuse-v1", disposition: "existing_policy_run",
    submittedRequestId: submitted.requestId, submittedRequestChecksum: sha(submitted), runId: saved.id, originalRequestId: original.requestId,
    originalRequestChecksum: sha(original), policy: ARTWORK_AUDIT_POLICY, orderLineId: original.orderLineId, revision: 2, editorVersionId: original.expectedEditorVersionId });
  const reviewer: ErpSessionView = { ...actor, permissions: [...actor.permissions, "design:read", "design:write"],
    permissionScopes: { ...actor.permissionScopes, "design:read": "tenant", "design:write": "tenant" } };
  const stamp = erpSessionAuthority(reviewer);
  const target = () => new Request(origin + "/api/ai-assists/runs", { method: "POST", headers: { origin, "content-type": "application/json", "x-yummyai-context-authority": stamp },
    body: JSON.stringify(submitted) });
  return { original, submitted, saved, proof, reviewer, stamp, target };
}

describe("AI assist authenticated proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue();
    mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status }));
    process.env.API_BASE_URL = "http://api.test";
  });

  it.each(["knowledge_answer", "artwork_preflight"] as const)("preserves shared usage history for %s before the client reads the original detail", async kind => {
    const reader = kind === "artwork_preflight" ? auditMetadata().reviewer : actor;
    mocks.identity.mockResolvedValue({ view: reader });
    const stamp = erpSessionAuthority(reader), automatic = kind === "artwork_preflight";
    const query = new URLSearchParams({ kind, scope: (automatic ? "order:" : "knowledge:") + createEntityId(), ...(automatic ? { automaticAudit: "1" } : {}) });
    const row: AssistHistoryEntry = { id: createEntityId(), status: "completed", createdAt: "2026-10-29T00:00:00.000Z", modelLabel: "Synthetic history model",
      tokenUsage: { version: "model-token-usage-v1", inputTokens: 100, outputTokens: 60, cachedInputTokens: 20, totalTokens: 160, totalTokensBasis: "provider" },
      usageSummary: { scope: "assist_scope", state: "complete", callCount: 1, reportedCalls: 1, unknownCalls: 0,
        inputTokens: 100, outputTokens: 60, cachedInputTokens: 20, totalTokens: 160 } };
    mocks.upstream.mockResolvedValueOnce(Response.json([row]));
    const response = await GET(new Request(`${origin}/api/ai-assists/runs?${query}`, { headers: { "x-yummyai-context-authority": stamp } }), context(["runs"]));
    expect(response.status).toBe(200); expect(await response.json()).toEqual([row]);
    expect(response.headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.upstream).toHaveBeenCalledWith(`http://api.test/v1/ai-assists/runs?${query}`, expect.objectContaining({ method: "GET", cache: "no-store" }));
    expect(mocks.current).toHaveBeenCalledOnce();
  });

  it("keeps legacy history readable but rejects unknown fields in the upstream history", async () => {
    const row = { id: createEntityId(), status: "completed", createdAt: "2026-10-29T00:00:00.000Z", modelLabel: "Synthetic legacy model" };
    const target = () => new Request(`${origin}/api/ai-assists/runs?kind=knowledge_answer&scope=knowledge:${createEntityId()}`,
      { headers: { "x-yummyai-context-authority": authority } });
    mocks.upstream.mockResolvedValueOnce(Response.json([row]));
    const legacy = await GET(target(), context(["runs"]));
    expect(legacy.status).toBe(200); expect(await legacy.json()).toEqual([row]);
    mocks.upstream.mockResolvedValueOnce(Response.json([{ ...row, syntheticPrivateBody: "Synthetic substituted response" }]));
    const invalid = await GET(target(), context(["runs"]));
    expect(invalid.status).toBe(502); expect(await invalid.text()).not.toContain("Synthetic substituted response");
  });

  it.each([
    ["assist_model_changed", "模型配置已变化 请刷新模型后核对再分析 当前填写仍保留"],
    ["assist_pricing_changed", "模型计价已变化 请刷新价格与单次上限后再分析 当前填写仍保留"],
    ["assist_concurrency_limit", "当前已有 4 个分析任务 请等待完成后再发起 当前填写仍保留"],
    ["assist_pricing_required", "请先为所选模型填写输入单价 输出单价和单次费用上限 当前填写仍保留"],
    ["assist_task_budget_exceeded", "本次预估超过组织单次 AI 预算 请核对限额后再分析 当前填写仍保留"],
    ["assist_unpriced_usage", "本月存在未计价的 AI 调用 请先核对账单与预算 当前填写仍保留"],
    ["assist_monthly_budget_exceeded", "组织当月 AI 预算不足 请核对预算后再分析 当前填写仍保留"],
  ])("exposes only the fixed safe configuration failure for POST runs 409: %s", async (code, message) => {
    const secret = "synthetic-upstream-secret-and-private-order-value";
    mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: secret, detail: secret }, { status: 409 }));
    const response = await POST(post(JSON.stringify(request())), context(["runs"]));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code, message });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.current).toHaveBeenCalledOnce();
    expect(mocks.upstream).toHaveBeenCalledOnce();
  });

  it("never passes through unknown codes or arbitrary upstream messages, including safe codes on another route or status", async () => {
    const secret = "synthetic-upstream-secret-and-private-order-value";
    for (const upstream of [
      Response.json({ code: "assist_private_provider_failure", message: secret }, { status: 409 }),
      Response.json({ code: "__proto__", message: secret }, { status: 409 }),
      Response.json({ code: "assist_model_changed", message: secret }, { status: 503 }),
      new Response(secret, { status: 409 }),
    ]) {
      mocks.upstream.mockResolvedValueOnce(upstream);
      const response = await POST(post(JSON.stringify(request())), context(["runs"]));
      const body = await response.json() as { code?: string; message: string };
      expect(body.code).toBeUndefined();
      expect(body.message).not.toContain(secret);
      expect(body.message).not.toContain("刷新模型");
      expect(body.message).toBe(response.status === 409 ? "原请求或固定依据存在冲突 请先读取原回执"
        : "分析请求结果暂不可核对 请保留原编号 不重复发起付费任务");
    }
    mocks.upstream.mockResolvedValueOnce(Response.json({ code: "assist_model_changed", message: secret }, { status: 409 }));
    const response = await GET(new Request(`${origin}/api/ai-assists/models`), context(["models"]));
    expect(await response.json()).toEqual({ message: "原请求或固定依据存在冲突 请先读取原回执" });
  });

  it("rejects cross-origin writes, oversized bodies, invalid JSON and unrelated routes before authentication forwarding", async () => {
    expect((await POST(post("{}", "http://elsewhere.test"), context(["runs"]))).status).toBe(403);
    expect((await POST(post(JSON.stringify({ prompt: "x".repeat(128 * 1024) })), context(["runs"]))).status).toBe(413);
    expect((await POST(post("{"), context(["runs"]))).status).toBe(400);
    expect((await GET(new Request(origin + "/api/ai-assists/admin"), context(["..", "admin"]))).status).toBe(404);
    expect(mocks.upstream).not.toHaveBeenCalled(); expect(mocks.identity).not.toHaveBeenCalled();
  });

  it("uses server authentication and private cache policy without forwarding caller credentials", async () => {
    const input = request(), saved = view(input);
    mocks.upstream.mockResolvedValue(Response.json(saved, { status: 201 }));
    const response = await POST(post(JSON.stringify(input)), context(["runs"]));
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(mocks.upstream).toHaveBeenCalledWith("http://api.test/v1/ai-assists/runs", expect.objectContaining({ method: "POST",
      body: JSON.stringify(input), headers: { "content-type": "application/json" }, cache: "no-store" }));
    expect(mocks.current).toHaveBeenCalledTimes(1);
    mocks.upstream.mockResolvedValueOnce(Response.json(saved));
    expect((await POST(post(JSON.stringify(input)), context(["runs"]))).status).toBe(502);
  });

  it("allows bounded task workspace routes and preserves only their authenticated query", async () => {
    mocks.upstream.mockResolvedValue(Response.json({ items: [], hasMore: false }));
    const response = await GET(new Request(origin + "/api/ai-assists/task-targets?kind=order_review&q=sample"), context(["task-targets"]));
    expect(response.status).toBe(200);
    expect(mocks.upstream).toHaveBeenCalledWith("http://api.test/v1/ai-assists/task-targets?kind=order_review&q=sample", expect.objectContaining({ cache: "no-store" }));
    expect((await GET(new Request(origin + "/api/ai-assists/task-targets?kind=order_review&kind=creative"), context(["task-targets"]))).status).toBe(400);
    expect((await POST(post("{}", "http://elsewhere.test"), context(["task-basis"]))).status).toBe(403);
    expect((await POST(post("{}"), context(["task-workspace"]))).status).toBe(404);
  });

  it("serves authenticated image bytes privately and sanitizes unexpected upstream errors", async () => {
    const id = createEntityId(), path = ["runs", id, "images", "0"], target = new Request(`${origin}/api/ai-assists/${path.join("/")}`);
    mocks.upstream.mockResolvedValue(new Response("synthetic image bytes"));
    const image = await GET(target, context(path));
    expect(image.headers.get("content-type")).toBe("image/jpeg"); expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect(image.headers.get("content-security-policy")).toContain("sandbox"); expect(await image.text()).toBe("synthetic image bytes");
    mocks.upstream.mockResolvedValue(Response.json({ message: "synthetic-upstream-private-detail" }, { status: 500 }));
    const failure = await GET(target, context(path)); expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain("synthetic-upstream-private-detail");
    expect((await GET(target, context(["runs", id, "images", "16"]))).status).toBe(404);
  });

  it("requires the current personal stamp and original request proof for read-only found and absent receipts", async () => {
    const input = request(), proof = new URLSearchParams({ requestId: input.requestId, requestChecksum: checksum(input) });
    const read = (stamp?: string) => new Request(`${origin}/api/ai-assists/receipts?${proof}`, { headers: stamp ? { "x-yummyai-context-authority": stamp } : {} });
    expect((await GET(read(), context(["receipts"]))).status).toBe(409); expect(mocks.upstream).not.toHaveBeenCalled();
    const saved = view(input); mocks.upstream.mockResolvedValueOnce(Response.json(receipt(input, saved)));
    const found = await GET(read(authority), context(["receipts"])); expect(found.status).toBe(200); expect((await found.json()).run.id).toBe(saved.id);
    mocks.upstream.mockResolvedValueOnce(Response.json(receipt(input, null)));
    expect(await (await GET(read(authority), context(["receipts"]))).json()).toMatchObject({ state: "not_found", run: null });
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...receipt(input, saved), requestId: randomUUID() }));
    expect((await GET(read(authority), context(["receipts"]))).status).toBe(502);
    expect(mocks.upstream.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect((await POST(post(JSON.stringify(input)), context(["receipts"]))).status).toBe(404);
  });

  it("verifies an expired original POST receipt and fences late identity changes without inventing another submission", async () => {
    const input = request(), saved = { ...view(input), request: null, stale: true };
    mocks.upstream.mockResolvedValueOnce(Response.json(saved, { status: 201 })).mockResolvedValueOnce(Response.json(receipt(input, saved)));
    const recovered = await POST(post(JSON.stringify(input)), context(["runs"])); expect(recovered.status).toBe(201);
    expect(mocks.upstream.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["POST", "GET"]);
    const calls = mocks.upstream.mock.calls.length;
    mocks.upstream.mockResolvedValueOnce(Response.json(view(input), { status: 201 }));
    mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const denied = await POST(post(JSON.stringify(input)), context(["runs"]));
    expect(denied.status).toBe(409); expect(await denied.json()).toMatchObject({ code: "authority_changed" });
    expect(mocks.upstream.mock.calls.length).toBe(calls + 1);
  });

  it("accepts an explicitly proved automatic audit policy reuse and keeps the original run and request identities", async () => {
    const sample = auditMetadata(); mocks.identity.mockResolvedValue({ view: sample.reviewer });
    mocks.upstream.mockResolvedValueOnce(Response.json(sample.saved, { status: 201, headers: { "x-yummyai-assist-reuse-proof": JSON.stringify(sample.proof) } }));
    const response = await POST(sample.target(), context(["runs"])); expect(response.status).toBe(201);
    expect((await response.json()).id).toBe(sample.saved.id);
    const proof = AssistAutomaticAuditReuseProofSchema.parse(JSON.parse(response.headers.get("x-yummyai-assist-reuse-proof")!));
    expect(proof.disposition).toBe("existing_policy_run"); expect(proof.originalRequestId).toBe(sample.original.requestId);
    expect(proof.submittedRequestId).toBe(sample.submitted.requestId); expect(proof.originalRequestId).not.toBe(proof.submittedRequestId);
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects missing or substituted automatic audit reuse proofs instead of treating a new request as persisted", async () => {
    const sample = auditMetadata(); mocks.identity.mockResolvedValue({ view: sample.reviewer });
    const forged = [null, { ...sample.proof, submittedRequestChecksum: "0".repeat(64) }, { ...sample.proof, originalRequestChecksum: "1".repeat(64) },
      { ...sample.proof, orderLineId: createEntityId() }, { ...sample.proof, revision: 3 }, { ...sample.proof, editorVersionId: createEntityId() },
      { ...sample.proof, policy: "synthetic-other-policy" }, { ...sample.proof, runId: createEntityId() }];
    for (const proof of forged) {
      mocks.upstream.mockResolvedValueOnce(Response.json(sample.saved, { status: 201, headers: proof ? { "x-yummyai-assist-reuse-proof": JSON.stringify(proof) } : {} }));
      const response = await POST(sample.target(), context(["runs"]));
      expect(response.status).toBe(502); expect(response.headers.has("x-yummyai-assist-reuse-proof")).toBe(false);
    }
    expect(mocks.upstream.mock.calls.length).toBe(forged.length);
  });

  it("allows the original image preview counter without forwarding it and rejects unrelated image queries before owner IO", async () => {
    const id = createEntityId(), path = ["runs", id, "images", "0"];
    for (const previewAttempt of ["0", "1"]) {
      mocks.upstream.mockResolvedValueOnce(new Response("synthetic preview image bytes"));
      const response = await GET(new Request(`${origin}/api/ai-assists/${path.join("/")}?previewAttempt=${previewAttempt}`), context(path));
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(await response.text()).toBe("synthetic preview image bytes");
    }
    expect(mocks.upstream.mock.calls.map(([url]) => String(url))).toEqual([
      `http://api.test/v1/ai-assists/runs/${id}/images/0`, `http://api.test/v1/ai-assists/runs/${id}/images/0`]);
    const count = mocks.upstream.mock.calls.length;
    for (const query of ["previewAttempt=-1", "previewAttempt=1.5", "previewAttempt=0&previewAttempt=1", "unrelated=1", "previewAttempt=0&unrelated=1"]) {
      const response = await GET(new Request(`${origin}/api/ai-assists/${path.join("/")}?${query}`), context(path));
      expect(response.status).toBe(400);
    }
    expect(mocks.upstream.mock.calls.length).toBe(count);
  });
});
