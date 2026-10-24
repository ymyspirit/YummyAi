import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { AdGoalFieldsSchema, AdImportInputSchema, AdObservationInputSchema } from "@yummyai/contracts/advertising";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";

const id = (last: number) => `019b0000-0000-7000-8000-${last.toString(16).padStart(12, "0")}`;
const account = id(1), other = id(2), importId = id(3), runId = id(4), actionId = id(5), exportId = id(6), at = "2026-09-16T18:00:00.000Z";
const access = { canRead: true, canWrite: false, canReview: false }, hash = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
const authority = erpSessionAuthority({ tenantId: id(90), userId: id(91), permissions: ["customer_intelligence:read"], dataScope: "tenant" });
const scope = { accountId: account, marketplace: "US", currency: "USD", asin: "B012345678" };
const importInput = () => AdImportInputSchema.parse({ accountId: account, marketplaceByCurrency: { USD: "US" }, timezone: "America/Los_Angeles", attributionWindowDays: 7,
  attributionBasis: "click", observedAt: at, files: [{ fileName: "campaign.csv", content: "Campaign,Spend\nsynthetic,10.00" }, { fileName: "target.csv", content: "Target,Spend\nsynthetic,10.00" }], idempotencyKey: "synthetic-original-import" });
const importView = (index = 0) => ({ id: index ? id(30 + index) : importId, accountId: account, fileName: importInput().files[index]!.fileName,
  checksum: hash(importInput().files[index]!.content), periodStart: "2026-09-01", periodEnd: "2026-09-15", reportType: "campaign",
  timezone: "America/Los_Angeles", attributionWindowDays: 7, attributionBasis: "click", observedAt: at, recordedAt: at,
  sourceRowCount: 1, acceptedRowCount: 1, rejectedRowCount: 0, diagnostics: [], archivedAt: null });
const workspace = (accountId: string | null = account) => ({ accountId, contextAuthority: authority, access,
  accounts: [{ id: account, name: "Synthetic advertising account", marketplaceIds: ["ATVPDKIKX0DER"], status: "pending", access }],
  imports: [importView()], goals: [], observations: [], actions: [], analyses: [] });
const fact = () => ({ sourceRow: 1, rowKey: "b".repeat(64), entityKey: "c".repeat(64), reportType: "campaign", adProduct: "SP", advertiserId: "synthetic",
  currency: "USD", marketplace: "US", periodStart: "2026-09-01", periodEnd: "2026-09-15", grain: "interval", campaignId: "campaign", campaignName: null,
  adGroupId: null, adGroupName: null, asin: null, productName: null, term: null, targetId: null, matchType: null, bidMinor: null, status: null, placement: null,
  metrics: { impressions: 1000, clicks: 40, purchases: 4, spendMinor: 1000, salesMinor: 4000 }, dimensions: {}, sourceFields: {}, qualityCodes: [] });
const factPage = () => ({ accountId: account, contextAuthority: authority, rows: [{ id: id(7), importId, accountId: account, observedAt: at,
  recordedAt: at, timezone: "America/Los_Angeles", attributionWindowDays: 7, attributionBasis: "click", fact: fact() }], count: 1, page: 1, pageSize: 50 });
const preview = () => ({ previewChecksum: "d".repeat(64), canCommit: true, files: importInput().files.map(file => ({ fileName: file.fileName, checksum: hash(file.content),
  byteSize: Buffer.byteLength(file.content), reportType: "campaign", headers: ["Campaign", "Spend"], sourceRowCount: 1, acceptedRowCount: 1,
  rejectedRowCount: 0, diagnosticCount: 0, diagnostics: [], sample: [fact()] })) });
const goalInput = () => ({ scope, expectedRevision: 0, fields: AdGoalFieldsSchema.parse({ mode: "profit_defense", effectiveFrom: "2026-09-01", targetAcosBps: 2100,
  unitPriceMinor: 10000, unitCostMinor: 7000, coreKeywords: [], protectedTerms: [], trialEndDate: null, trialSpendLimitMinor: null }), idempotencyKey: "synthetic-original-goal" });
const goal = () => ({ id: id(8), productId: id(9), revision: 1, scope, fields: goalInput().fields, checksum: "e".repeat(64), createdAt: at });
const observationInput = () => AdObservationInputSchema.parse({ scope, kind: "commerce", periodStart: "2026-09-01", periodEnd: "2026-09-15", source: "Synthetic original commerce report",
  keyword: null, organicRank: null, totalSalesMinor: 5000, totalPurchases: 8, preAdContributionMinor: 2500, adsCoverageConfirmed: true, observedAt: at, idempotencyKey: "synthetic-original-observation" });
const observation = () => { const { idempotencyKey: omitted, ...body } = observationInput(); void omitted; return { ...body, id: id(10), createdAt: at }; };
const analysisInput = () => ({ accountId: account, periodStart: "2026-09-01", periodEnd: "2026-09-15", marketplace: null, currency: null, evidenceCutoffAt: at, idempotencyKey: "synthetic-original-analysis" });
const run = () => ({ id: runId, accountId: account, periodStart: "2026-09-01", periodEnd: "2026-09-15", marketplace: null, currency: null, evidenceCutoffAt: at, status: "partial", inputChecksum: "f".repeat(64), createdAt: at,
  result: { controlType: "campaign", totals: [], products: [], recommendations: [], diagnostics: [], evidenceImportIds: [importId], goalVersionIds: [], selectedFactCount: 1, supersededFactCount: 0, dailyTrend: [] } });
const action = () => ({ id: actionId, runId, status: "adopted", revision: 2, createdAt: at, updatedAt: at, executedAt: null, actualBeforeMinor: null, actualAfterMinor: null, execution: null, events: [],
  recommendation: { key: "a".repeat(64), ruleId: "SYNTHETIC", kind: "lower_bid", priority: "normal", productId: id(9), goalVersionId: id(8), scope, accountId: account,
    currency: "USD", marketplace: "US", campaignId: "campaign", adGroupId: "group", targetId: "target", term: "custom pillow", title: "Synthetic bounded bid review", reason: "Synthetic economics only",
    currentBidMinor: 100, proposedBidMinor: 85, changeBps: -1500, periodStart: "2026-09-01", periodEnd: "2026-09-15", metrics: fact().metrics, evidenceKeys: ["b".repeat(64)], constraints: [], reviewAfter: "2026-09-22" } });
const exported = () => ({ id: exportId, runId, checksum: "b".repeat(64), createdAt: at, reviewReason: "Synthetic manual review",
  payload: { schemaVersion: 1, run: run(), actions: [action()], sourcePins: [importView()], reviewedBy: id(11), marketplaceExecution: "manual" } });
const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });
const url = (path: string) => `http://localhost:3130/api/advertising/${path}`;
const get = (path: string, query = "") => GET(new Request(`${url(path)}${query}`), ctx(path));
const post = (path: string, body: unknown, origin = "http://localhost:3130") => POST(new Request(url(path), { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), ctx(path));
const success = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: extra });
beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("WEB_AUTH_MODE", "personal"); vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130"); upstream.mockReset(); });
afterEach(() => vi.unstubAllEnvs());

describe("advertising BFF personal authority and original response boundary", () => {
  it("rejects cross-origin mutation and arbitrary upstream paths without contacting API", async () => {
    expect((await post("goals", goalInput(), "https://external.invalid")).status).toBe(403);
    expect((await get("../orders")).status).toBe(404); expect((await get(`imports/${account}/delete`)).status).toBe(404); expect(upstream).not.toHaveBeenCalled();
  });
  it("validates read scope and forwards API denial as an explicit no-store state", async () => {
    expect((await get("facts", "?accountId=missing")).status).toBe(400);
    upstream.mockResolvedValue(success({ message: "SYNTHETIC-PRIVATE-DATABASE-DETAIL", stack: "private" }, 403));
    const response = await get("workspace", `?accountId=${account}`);
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(await response.text()).not.toContain("SYNTHETIC-PRIVATE");
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:8130/v1/advertising/workspace?accountId=${account}`);
  });
  it("streams only validated private export attachments with a server-owned safe filename", async () => {
    upstream.mockResolvedValue(success(exported(), 200, { "content-disposition": 'attachment; filename="untrusted-upstream-name.json"', authorization: "synthetic-never-forward", "set-cookie": "synthetic-never-forward" }));
    const response = await get(`exports/${exportId}`);
    expect(response.status).toBe(200); expect(response.headers.get("content-disposition")).toBe(`attachment; filename="advertising-review-${exportId}.json"`);
    expect(response.headers.has("authorization")).toBe(false); expect(response.headers.has("set-cookie")).toBe(false); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual(exported());
  });
  it("uses authenticated apiFetch for a production personal connection including a non-loopback API", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("API_BASE_URL", "https://synthetic-api.example.invalid"); upstream.mockResolvedValue(success(workspace()));
    const response = await get("workspace", `?accountId=${account}`); expect(response.status).toBe(200);
    const [target, init] = upstream.mock.calls[0]!; expect(target).toBe(`https://synthetic-api.example.invalid/v1/advertising/workspace?accountId=${account}`);
    expect(init).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" }); expect(new Headers(init.headers).has("authorization")).toBe(false);
  });
  it("does not replace a real personal login failure with a service identity or private data", async () => {
    vi.stubEnv("NODE_ENV", "production"); upstream.mockResolvedValue(success({ code: "login_required", token: "synthetic-private-token" }, 401));
    const response = await get("workspace"); expect(response.status).toBe(401); expect(await response.text()).not.toContain("synthetic-private-token"); expect(upstream).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 403, 404, 409, 413, 422, 429, 503])("preserves public HTTP %s without reflecting backend message, key or stack", async status => {
    upstream.mockResolvedValue(success({ message: "SYNTHETIC-PRIVATE-SOURCE-KEY", stack: "SYNTHETIC-PRIVATE-STACK" }, status));
    const response = await post("imports/preview", importInput()); expect(response.status).toBe(status); expect(await response.text()).not.toContain("SYNTHETIC-PRIVATE"); expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("rejects duplicate and unknown query parameters on reads and all query parameters on mutations", async () => {
    for (const [path, query] of [["workspace", `?accountId=${account}&accountId=${account}`], ["facts", `?accountId=${account}&page=1&page=2`], ["workspace", "?tenantId=caller-selected"], [`exports/${exportId}`, `?accountId=${account}`]])
      expect((await get(path!, query!)).status).toBe(400);
    expect((await POST(new Request(`${url("goals")}?accountId=${account}`, { method: "POST", headers: { origin: "http://localhost:3130", "content-type": "application/json" }, body: JSON.stringify(goalInput()) }), ctx("goals"))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects a non-JSON mutation and malformed UTF-8 before calling the API", async () => {
    expect((await POST(new Request(url("goals"), { method: "POST", headers: { origin: "http://localhost:3130", "content-type": "text/plain" }, body: "{}" }), ctx("goals"))).status).toBe(400);
    expect((await POST(new Request(url("goals"), { method: "POST", headers: { origin: "http://localhost:3130", "content-type": "application/json" }, body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]) }), ctx("goals"))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("enforces the 24 MiB streaming request bound without trusting Content-Length", async () => {
    const response = await POST(new Request(url("imports/preview"), { method: "POST", headers: { origin: "http://localhost:3130", "content-type": "application/json", "content-length": "1" }, body: "x".repeat(24 * 1024 * 1024 + 1) }), ctx("imports/preview"));
    expect(response.status).toBe(413); expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects caller-added authority and non-finite or unsafe numeric business inputs", async () => {
    for (const body of [{ ...goalInput(), tenantId: other }, { ...goalInput(), fields: { ...goalInput().fields, unitCostMinor: Number.MAX_SAFE_INTEGER + 1 } }, { ...goalInput(), fields: { ...goalInput().fields, unitCostMinor: 0.1 } }])
      expect((await post("goals", body)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects a workspace for a different requested account even when it is otherwise valid", async () => {
    upstream.mockResolvedValue(success(workspace(null))); expect((await get("workspace", `?accountId=${account}`)).status).toBe(502);
    upstream.mockResolvedValue(success(workspace())); expect((await get("workspace")).status).toBe(502);
  });
  it("rejects missing authority, a capability escalation and private rows in a Write-only workspace", async () => {
    const value = workspace(), { contextAuthority: omitted, ...missing } = value; void omitted;
    for (const body of [missing, { ...value, contextAuthority: "a".repeat(64) }, { ...value, accounts: [{ ...value.accounts[0]!, access: { ...access, canWrite: true } }] },
      { ...value, access: { canRead: false, canWrite: true, canReview: false }, accounts: [{ ...value.accounts[0]!, access: { canRead: false, canWrite: true, canReview: false } }] }]) {
      upstream.mockResolvedValue(success(body)); expect((await get("workspace", `?accountId=${account}`)).status).toBe(502);
    }
  });
  it("can transport Write-only account discovery without reading any private source", async () => {
    const writeAccess = { canRead: false, canWrite: true, canReview: false }, value = { ...workspace(),
      contextAuthority: erpSessionAuthority({ tenantId: id(90), userId: id(91), permissions: ["customer_intelligence:write"], dataScope: "tenant" }),
      access: writeAccess, imports: [], accounts: [{ ...workspace().accounts[0]!, access: writeAccess }] };
    upstream.mockResolvedValue(success(value)); expect((await get("workspace", `?accountId=${account}`)).status).toBe(200); expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("binds fact pages to the account, requested page, page size and report family", async () => {
    for (const body of [{ ...factPage(), page: 2 }, { ...factPage(), pageSize: 1 }, { ...factPage(), accountId: other, rows: [] }, factPage()]) {
      upstream.mockResolvedValue(success(body)); expect((await get("facts", `?accountId=${account}&reportType=targeting&page=1&pageSize=50`)).status).toBe(502);
    }
    upstream.mockResolvedValue(success(factPage())); expect((await get("facts", `?accountId=${account}&reportType=campaign&page=1&pageSize=50`)).status).toBe(200);
  });
  it("binds preview files to every original filename and byte checksum", async () => {
    for (const body of [{ ...preview(), files: [preview().files[0]!] }, { ...preview(), files: preview().files.map((file, index) => index ? file : { ...file, checksum: "f".repeat(64) }) },
      { ...preview(), files: preview().files.map((file, index) => index ? file : { ...file, fileName: "different.csv" }) }]) {
      upstream.mockResolvedValue(success(body, 201)); expect((await post("imports/preview", importInput())).status).toBe(502);
    }
    upstream.mockResolvedValue(success(preview(), 201)); expect((await post("imports/preview", importInput())).status).toBe(201);
  });
  it("forwards the original commit key and byte text unchanged and returns actual new and replay receipts", async () => {
    const body = { ...importInput(), previewChecksum: preview().previewChecksum };
    for (const replayed of [false, true]) { upstream.mockResolvedValue(success({ imports: [importView(), importView(1)], replayed }, 201)); const response = await post("imports", body);
      expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ replayed }); }
    expect(upstream).toHaveBeenCalledTimes(2); for (const [, init] of upstream.mock.calls) expect(JSON.parse(init.body)).toEqual(body);
  });
  it("requires a one-to-one commit file mapping rather than duplicated pins with different IDs", async () => {
    const body = { ...importInput(), previewChecksum: preview().previewChecksum };
    for (const imports of [[importView(), { ...importView(), id: id(31) }], [importView(), { ...importView(1), id: importId }],
      [importView(), { ...importView(1), accountId: other }], [importView(), { ...importView(1), checksum: "f".repeat(64) }]]) {
      upstream.mockResolvedValue(success({ imports, replayed: false }, 201)); expect((await post("imports", body)).status).toBe(502);
    }
  });
  it("binds committed reports to their original timezone, attribution, observation time and explicit report family", async () => {
    const body = { ...importInput(), previewChecksum: preview().previewChecksum };
    for (const changed of [{ timezone: "UTC" }, { attributionWindowDays: null }, { attributionBasis: "click_and_view" }, { observedAt: "2026-09-17T18:00:00.000Z" }]) {
      upstream.mockResolvedValue(success({ imports: [{ ...importView(), ...changed }, importView(1)], replayed: false }, 201));
      expect((await post("imports", body)).status).toBe(502);
    }
    upstream.mockResolvedValue(success({ imports: [importView(), importView(1)], replayed: false }, 201));
    expect((await post("imports", { ...body, files: [{ ...body.files[0]!, reportTypeHint: "targeting" }, body.files[1]!] })).status).toBe(502);
  });
  it("binds a saved goal to its actual product scope and all reviewed economics fields", async () => {
    for (const body of [{ ...goal(), scope: { ...scope, accountId: other } }, { ...goal(), fields: { ...goal().fields, unitCostMinor: 0 } }, { ...goal(), revision: 2 }]) {
      upstream.mockResolvedValue(success(body, 201)); expect((await post("goals", goalInput())).status).toBe(502);
    }
    upstream.mockResolvedValue(success(goal(), 201)); expect((await post("goals", goalInput())).status).toBe(201);
  });
  it("binds the observation receipt to its source, exact numeric evidence and original observed time", async () => {
    for (const body of [{ ...observation(), source: "Different source" }, { ...observation(), totalSalesMinor: 5001 }, { ...observation(), totalPurchases: 9 },
      { ...observation(), preAdContributionMinor: null }, { ...observation(), observedAt: "2026-09-17T18:00:00.000Z" }]) {
      upstream.mockResolvedValue(success(body, 201)); expect((await post("observations", observationInput())).status).toBe(502);
    }
    upstream.mockResolvedValue(success(observation(), 201)); expect((await post("observations", observationInput())).status).toBe(201);
  });
  it("binds a returned analysis to the requested scope and exact evidence cutoff", async () => {
    for (const body of [{ ...run(), accountId: other }, { ...run(), evidenceCutoffAt: "2026-09-17T18:00:00.000Z" }, { ...run(), periodStart: "2026-09-02" }]) {
      upstream.mockResolvedValue(success(body, 201)); expect((await post("analyses", analysisInput())).status).toBe(502);
    }
    upstream.mockResolvedValue(success(run(), 201)); expect((await post("analyses", analysisInput())).status).toBe(201);
  });
  it("binds action and archive receipts to their actual path identifiers", async () => {
    upstream.mockResolvedValue(success({ ...action(), id: other }, 201));
    expect((await post(`actions/${actionId}/events`, { expectedRevision: 1, expectedStatus: "pending", status: "adopted", reason: "Synthetic review", idempotencyKey: "synthetic-original-action" })).status).toBe(502);
    upstream.mockResolvedValue(success({ ...importView(), id: other, archivedAt: at }, 201));
    expect((await post(`imports/${importId}/archive`, { reason: "Synthetic superseded report", idempotencyKey: "synthetic-original-archive" })).status).toBe(502);
  });
  it("requires an actual recorded transition event and an advanced revision", async () => {
    const body = { expectedRevision: 1, expectedStatus: "pending", status: "adopted", reason: "Synthetic exact approval", idempotencyKey: "synthetic-original-adopt" };
    const proof = { id: id(40), status: "adopted", reason: body.reason, at };
    for (const value of [{ ...action(), events: [] }, { ...action(), revision: 1, events: [proof] },
      { ...action(), status: "rejected", events: [proof] }, { ...action(), events: [{ ...proof, reason: "Different approval" }] }]) {
      upstream.mockResolvedValue(success(value, 201)); expect((await post(`actions/${actionId}/events`, body)).status).toBe(502);
    }
    upstream.mockResolvedValue(success({ ...action(), events: [proof] }, 201)); expect((await post(`actions/${actionId}/events`, body)).status).toBe(201);
  });
  it("accepts an exact old transition replay from a later projection without pretending its current status is the old status", async () => {
    const body = { expectedRevision: 1, expectedStatus: "pending", status: "adopted", reason: "Synthetic exact approval", idempotencyKey: "synthetic-original-adopt" };
    const later = { ...action(), status: "observing", revision: 4, events: [{ id: id(40), status: "adopted", reason: body.reason, at },
      { id: id(41), status: "executed", reason: "Synthetic actual manual change", at }, { id: id(42), status: "observing", reason: "Synthetic observation", at }] };
    upstream.mockResolvedValue(success(later, 201)); const response = await post(`actions/${actionId}/events`, body);
    expect(response.status).toBe(201); expect(await response.json()).toEqual(later);
  });
  it("binds executed transitions to the exact time, before and after amounts, and execution IDs", async () => {
    const body = { expectedRevision: 2, expectedStatus: "adopted", status: "executed", reason: "Synthetic actual manual change", executedAt: at,
      actualBeforeMinor: 100, actualAfterMinor: 85, executionCampaignId: "campaign", executionAdGroupId: "group", executionTargetId: "target", idempotencyKey: "synthetic-original-executed" };
    const receipt = { ...action(), status: "executed", revision: 3, executedAt: at, actualBeforeMinor: 100, actualAfterMinor: 85,
      execution: { campaignId: "campaign", adGroupId: "group", targetId: "target" }, events: [{ id: id(41), status: "executed", reason: body.reason, at }] };
    for (const value of [{ ...receipt, executedAt: "2026-09-17T18:00:00.000Z" }, { ...receipt, actualBeforeMinor: 101 }, { ...receipt, actualAfterMinor: 84 },
      { ...receipt, execution: { ...receipt.execution, targetId: "another-target" } }]) {
      upstream.mockResolvedValue(success(value, 201)); expect((await post(`actions/${actionId}/events`, body)).status).toBe(502);
    }
    upstream.mockResolvedValue(success(receipt, 201)); expect((await post(`actions/${actionId}/events`, body)).status).toBe(201);
  });
  it("does not claim an unarchived import was archived", async () => {
    const body = { reason: "Synthetic superseded report", idempotencyKey: "synthetic-original-archive" };
    upstream.mockResolvedValue(success(importView(), 201)); expect((await post(`imports/${importId}/archive`, body)).status).toBe(502);
    upstream.mockResolvedValue(success({ ...importView(), archivedAt: at }, 201)); expect((await post(`imports/${importId}/archive`, body)).status).toBe(201);
  });
  it("binds an export to the requested immutable export, run and selected actions", async () => {
    upstream.mockResolvedValue(success({ ...exported(), id: other })); expect((await get(`exports/${exportId}`)).status).toBe(502);
    for (const body of [{ ...exported(), runId: other }, { ...exported(), payload: { ...exported().payload, actions: [] } }]) {
      upstream.mockResolvedValue(success(body, 201)); expect((await post("exports", { runId, actionIds: [actionId], reviewReason: "Synthetic manual review", idempotencyKey: "synthetic-original-export" })).status).toBe(502);
    }
  });
  it("returns the original CSV bytes and never trusts an upstream attachment name", async () => {
    const body = "\ufeff日期,说明\r\n2026-09-01,\"synthetic,quoted\"\r\n";
    upstream.mockResolvedValue(new Response(body, { headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="../../private.csv"', authorization: "synthetic-private" } }));
    const response = await get(`imports/${importId}/source`); expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(body, "utf8"));
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="advertising-source-${importId}.csv"`); expect(response.headers.has("authorization")).toBe(false);
  });
  it("rejects private CSV with a wrong content type or malformed UTF-8", async () => {
    for (const response of [new Response("<html>synthetic</html>", { headers: { "content-type": "text/html" } }), new Response(new Uint8Array([0xff]), { headers: { "content-type": "text/csv" } })]) {
      upstream.mockResolvedValue(response); expect((await get(`imports/${importId}/source`)).status).toBe(502);
    }
  });
  it("bounds private source downloads at 5 MiB and JSON responses at 32 MiB", async () => {
    upstream.mockResolvedValue(new Response("x".repeat(5 * 1024 * 1024 + 1), { headers: { "content-type": "text/csv", "content-length": "1" } }));
    expect((await get(`imports/${importId}/source`)).status).toBe(502);
    upstream.mockResolvedValue(new Response(" ".repeat(32 * 1024 * 1024 + 1), { headers: { "content-type": "application/json", "content-length": "1" } }));
    expect((await get("workspace", `?accountId=${account}`)).status).toBe(502);
  });
  it("does not mistake a different HTTP success status or malformed JSON for a committed receipt", async () => {
    upstream.mockResolvedValue(success(goal(), 200)); expect((await post("goals", goalInput())).status).toBe(502);
    upstream.mockResolvedValue(new Response("{not-json}", { headers: { "content-type": "application/json" } })); expect((await get("workspace")).status).toBe(502);
  });
  it("keeps a network failure unknown, performs no automatic retry, and preserves the manual retry's original body and key", async () => {
    const body = observationInput(); upstream.mockRejectedValueOnce(new Error("SYNTHETIC-PRIVATE-NETWORK-DETAIL"));
    const response = await post("observations", body); expect(response.status).toBe(502); expect(await response.text()).not.toContain("SYNTHETIC-PRIVATE"); expect(upstream).toHaveBeenCalledTimes(1);
    upstream.mockResolvedValueOnce(success(observation(), 201)); expect((await post("observations", body)).status).toBe(201);
    expect(upstream).toHaveBeenCalledTimes(2); expect(upstream.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([body, body]);
  });
  it("preserves only the known authority_changed code so a late personal response clears private UI state", async () => {
    upstream.mockResolvedValue(success({ code: "authority_changed", message: "SYNTHETIC-PRIVATE-AUTHORITY-DETAIL", stack: "private" }, 409));
    const response = await post("observations", observationInput()); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "authority_changed" }); expect(upstream).toHaveBeenCalledTimes(1);
    upstream.mockResolvedValue(success({ code: "SYNTHETIC-PRIVATE-UNKNOWN-CODE", message: "private" }, 409));
    expect(await (await post("observations", observationInput())).text()).not.toContain("SYNTHETIC-PRIVATE");
  });
  it("rejects an unconfigured API without contacting a fallback identity", async () => {
    vi.stubEnv("API_BASE_URL", ""); expect((await get("workspace")).status).toBe(503); expect(upstream).not.toHaveBeenCalled();
  });
});
