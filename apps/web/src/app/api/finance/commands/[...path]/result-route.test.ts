import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import type { FinanceCommandSummary } from "@yummyai/contracts/finance/finance-command";
import { FinanceCommandRecordedResultSchema, FinanceCommandResultPageSchema } from "@yummyai/contracts/finance/finance-command-result";
const upstream = vi.hoisted(() => vi.fn());
vi.mock("../../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";

const commandId = createEntityId(), resultId = createEntityId(), factIds = [createEntityId(), createEntityId(), createEntityId()];
const at = "2026-07-03T00:00:00.100Z", hash = "a".repeat(64), authority = "synthetic-result-authority";
const root = "http://localhost:3130/api/finance/commands", context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const position = (offset = 1, anchor = factIds[0]!, scope = hash) => ({ v: 1, scope, offset, anchor });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const result = { kind: "statement_record" as const, id: resultId, parentId: null, version: null };
const fact = (index = 0) => ({ id: factIds[index]!, statementId: resultId, accountId: null, sourceEntryId: `synthetic-original-${index}`,
  lineKey: `original-${index}`, factType: "production_cost" as const, direction: "debit" as const, amountMinor: index === 0 ? 0 : Number.MAX_SAFE_INTEGER,
  currency: "JPY", occurredAt: at, externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null,
  correctionKind: "original" as const, correctsFactId: null, recordedAt: at });
function recorded() {
  return FinanceCommandRecordedResultSchema.parse({ commandId, kind: result.kind, targetId: null, result, executedAt: at, recorded: { kind: result.kind,
    record: { id: resultId, sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-HISTORICAL-EVIDENCE" }, accountId: null,
      provider: "manual", statementKind: "operational_cost", externalStatementId: "SYNTHETIC-ORIGINAL-REPORT", periodStart: at, periodEnd: at,
      sourceCurrency: "JPY", observedAt: at, recordedAt: at, checksum: hash } }, currentVerification: null,
    collections: [{ section: "facts", total: 3 }], contextAuthority: authority, consistency: "immutable_execution" });
}
function page(offset = 0) {
  return FinanceCommandResultPageSchema.parse({ commandId, result, section: "facts", items: [fact(offset)], limit: 1, offset, total: 3,
    hasMore: offset < 2, nextCursor: offset < 2 ? encode(position(offset + 1, factIds[offset]!)) : null,
    contextAuthority: authority, consistency: "immutable_execution" });
}
const request = (suffix = "result", query = "") => new Request(`${root}/${commandId}/${suffix}${query}`);
const summary = (status: FinanceCommandSummary["status"] = "succeeded"): FinanceCommandSummary => ({ id: commandId, kind: "statement_record", targetId: null,
  status, requestKey: "synthetic-result-original-key", createdAt: at, expiresAt: "2026-07-10T00:00:00.100Z", completedAt: at,
  acknowledged: true, originalRetained: false, result: status === "succeeded" ? result : null, contextAuthority: authority });
const list = (item = summary()) => ({ items: [item], nextCursor: null, unavailableCount: 0, contextAuthority: authority });

beforeEach(() => { upstream.mockReset(); vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130"); });
afterEach(() => vi.unstubAllEnvs());

describe("personal immutable finance result BFF", () => {
  it("reads only the exact original command result with session authentication and private no-store", async () => {
    const value = recorded(); upstream.mockResolvedValue(Response.json(value));
    const response = await GET(request(), context(commandId.toUpperCase(), "result"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
    expect(upstream).toHaveBeenCalledOnce(); const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe(`http://127.0.0.1:8130/v1/finance/commands/${commandId}/result`);
    expect(init).toMatchObject({ method: "GET", cache: "no-store" }); expect(init.body).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("preserves zero and maximum-safe JPY facts without substituting current balances or a second request", async () => {
    for (const offset of [0, 1, 2]) {
      const value = page(offset), query = `?section=facts&limit=1${offset ? `&cursor=${encode(position(offset, factIds[offset - 1]!))}` : ""}`;
      upstream.mockResolvedValueOnce(Response.json(value));
      const response = await GET(request("result/entries", query), context(commandId, "result", "entries"));
      expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
    }
    expect(upstream).toHaveBeenCalledTimes(3);
  });
  it("normalizes default limit once and retains the exact canonical cursor in the upstream query", async () => {
    const value = { ...page(), limit: 25, total: 1, hasMore: false, nextCursor: null }; upstream.mockResolvedValueOnce(Response.json(value));
    expect((await GET(request("result/entries", "?section=facts"), context(commandId, "result", "entries"))).status).toBe(200);
    expect(upstream.mock.calls[0]![0]).toContain("?section=facts&limit=25");
    const next = encode(position()); upstream.mockResolvedValueOnce(Response.json(page(1)));
    expect((await GET(request("result/entries", `?section=facts&limit=1&cursor=${next}`), context(commandId, "result", "entries"))).status).toBe(200);
    expect(upstream.mock.calls[1]![0]).toContain(`cursor=${next}`);
  });
  it("permits acknowledged successes in recorded history while rejecting them from active history", async () => {
    upstream.mockResolvedValueOnce(Response.json(list()));
    const recordedList = await GET(new Request(`${root}?view=recorded&kind=statement_record&targetId=root`), context());
    expect(recordedList.status).toBe(200); expect((await recordedList.json()).items[0].acknowledged).toBe(true);
    expect(upstream.mock.calls[0]![0]).toContain("view=recorded");
    upstream.mockResolvedValueOnce(Response.json(list())); expect((await GET(new Request(`${root}?view=active`), context())).status).toBe(502);
    upstream.mockResolvedValueOnce(Response.json(list(summary("cancelled"))));
    expect((await GET(new Request(`${root}?view=recorded`), context())).status).toBe(502);
  });
  it("rejects result POSTs, unknown detail queries and duplicate or malformed collection queries before upstream I/O", async () => {
    expect((await POST(new Request(`${root}/${commandId}/result`, { method: "POST" }), context(commandId, "result"))).status).toBe(404);
    expect((await GET(request("result", "?original=true"), context(commandId, "result"))).status).toBe(400);
    for (const query of ["?section=facts&section=cost_shares", "?section=facts&limit=01", "?section=facts&limit=101", "?section=facts&tenantId=ignored",
      "?section=facts&cursor=notcanonical", `?section=facts&cursor=${encode({ ...position(), offset: 0 })}`, `?section=facts&cursor=${encode({ scope: hash, v: 1, offset: 1, anchor: factIds[0] })}`])
      expect((await GET(request("result/entries", query), context(commandId, "result", "entries"))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects a different command, substituted actual record and missing authority rather than inventing success", async () => {
    const value = recorded();
    for (const change of [{ commandId: createEntityId() }, { result: { ...result, id: createEntityId() } }, { contextAuthority: "" },
      { collections: [] }, { recorded: { ...value.recorded, record: { ...value.recorded.record, id: createEntityId() } } }, { original: { input: "SYNTHETIC-PRIVATE" } }]) {
      upstream.mockResolvedValueOnce(Response.json({ ...value, ...change })); expect((await GET(request(), context(commandId, "result"))).status).toBe(502);
    }
  });
  it("rejects a substituted page command, result parent, section, limit, offset and contradictory total", async () => {
    const value = page();
    for (const change of [{ commandId: createEntityId() }, { section: "allocations" }, { limit: 25 }, { offset: 1 }, { total: 0 },
      { result: { ...result, kind: "payment_record" } }, { items: [{ ...fact(), statementId: createEntityId() }] }]) {
      upstream.mockResolvedValueOnce(Response.json({ ...value, ...change }));
      expect((await GET(request("result/entries", "?section=facts&limit=1"), context(commandId, "result", "entries"))).status).toBe(502);
    }
  });
  it("rejects a next cursor that is noncanonical, skips a row, retreats or anchors a different actual row", async () => {
    for (const nextCursor of ["notcanonical", encode(position(2)), encode(position(1, createEntityId())),
      Buffer.from(` {"v":1,"scope":"${hash}","offset":1,"anchor":"${factIds[0]}"}`).toString("base64url")]) {
      upstream.mockResolvedValueOnce(Response.json({ ...page(), nextCursor }));
      expect((await GET(request("result/entries", "?section=facts&limit=1"), context(commandId, "result", "entries"))).status).toBe(502);
    }
    const prior = encode(position());
    for (const nextCursor of [prior, encode(position(2, factIds[1]!, "b".repeat(64)))]) {
      upstream.mockResolvedValueOnce(Response.json({ ...page(1), nextCursor }));
      expect((await GET(request("result/entries", `?section=facts&limit=1&cursor=${prior}`), context(commandId, "result", "entries"))).status).toBe(502);
    }
  });
  it.each([401, 403, 404, 409, 413, 422, 503])("retains real %i result failures without leaking upstream body, retry or fallback", async status => {
    upstream.mockResolvedValueOnce(Response.json({ code: "finance_command_result_unavailable", message: "SYNTHETIC-PRIVATE-UPSTREAM-BODY", credential: "SYNTHETIC-PRIVATE-CREDENTIAL" }, { status }));
    const response = await GET(request(), context(commandId, "result")); expect(response.status).toBe(status);
    const body = await response.text(); expect(body).toContain("finance_command_result_unavailable"); expect(body).not.toContain("SYNTHETIC-PRIVATE");
    expect(upstream).toHaveBeenCalledOnce(); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("refuses oversized or malformed actual results instead of clipping them into a false-complete response", async () => {
    for (const suffix of ["result", "result/entries"]) {
      upstream.mockResolvedValueOnce(new Response(new Uint8Array((suffix === "result" ? 8 : 4) * 1024 * 1024 + 1), { status: 200 }));
      const path = suffix === "result" ? [commandId, "result"] : [commandId, "result", "entries"];
      expect((await GET(request(suffix, suffix === "result" ? "" : "?section=facts"), context(...path))).status).toBe(502);
    }
    upstream.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }));
    expect((await GET(request(), context(commandId, "result"))).status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(3);
  });
  it("never replaces network-unknown or unexpected-status receipts with a new write", async () => {
    upstream.mockRejectedValueOnce(new Error("SYNTHETIC-PRIVATE-NETWORK"));
    const failed = await GET(request(), context(commandId, "result")); expect(failed.status).toBe(502); expect(await failed.text()).not.toContain("SYNTHETIC-PRIVATE");
    upstream.mockResolvedValueOnce(Response.json(recorded(), { status: 201 }));
    expect((await GET(request(), context(commandId, "result"))).status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls.every(([, init]) => init.method === "GET" && init.body === undefined)).toBe(true);
  });
});
