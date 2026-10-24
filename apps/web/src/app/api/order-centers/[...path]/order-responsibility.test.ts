import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderLineResponsibilityViewSchema } from "@yummyai/contracts/order/responsibility";
import {
  OrderTaskInboxQuerySchema,
  OrderTaskInboxViewSchema,
} from "@yummyai/contracts/order/task-inbox";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";

const id = "019f0000-0000-7000-8000-000000000001",
  orderId = "019f0000-0000-7000-8000-000000000002";
const path = ["lines", id, "responsibility"],
  url = `http://web.test/api/order-centers/${path.join("/")}`;
const context = (value = path) => ({ params: Promise.resolve({ path: value }) });
const input = {
  expectedRevision: 0,
  expectedSourceChecksum: "a".repeat(64),
  assignedUserId: id,
  dueAt: null,
  escalationUserId: null,
  escalationDelayMinutes: null,
  reason: "initial_assignment",
};
const view = () =>
  OrderLineResponsibilityViewSchema.parse({
    lineId: id,
    orderId,
    revision: 0,
    assignmentRevision: 0,
    currentTaskKey: "review_order",
    openExceptionCount: 0,
    currentTask: "核对买家定制要求",
    active: true,
    available: true,
    sourceChecksum: "a".repeat(64),
    businessRevision: 0,
    businessProjectionVersion: 0,
    reminderCycle: 0,
    lastReason: null,
    assignedUserId: null,
    assignedUserName: null,
    dueAt: null,
    escalationUserId: null,
    escalationUserName: null,
    escalationDelayMinutes: null,
    canManage: true,
    candidates: [],
    candidatesTruncated: false,
    assignmentNotifiedAt: null,
    dueNotifiedAt: null,
    escalationNotifiedAt: null,
    nextCheckAt: null,
    lastError: null,
  });
const list = () =>
  OrderTaskInboxViewSchema.parse({
    source: "order",
    asOf: "2026-10-16T00:00:00Z",
    query: OrderTaskInboxQuerySchema.parse({}),
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
    summary: { overdue: 0, dueToday: 0, attention: 0, unassigned: 0, unavailable: 0 },
  });
const write = (body: unknown = input, origin = "http://web.test", query = "") =>
  new Request(url + query, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
describe("order responsibility and inbox boundary", () => {
  beforeEach(() => {
    upstream.mockReset();
    vi.stubEnv("API_BASE_URL", "http://api.test");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("bounds member lookup and rejects caller scope and duplicate queries before contacting the API", async () => {
    for (const query of ["?tenantId=x", "?q=a&q=b", "?q=" + "a".repeat(101), "?userId=" + id])
      expect((await GET(new Request(url + query), context())).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    upstream.mockResolvedValue(Response.json(view()));
    const result = await GET(new Request(url + "?q=%25_%E5%BC%A0"), context());
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(upstream.mock.calls[0]?.[0]).toBe(
      "http://api.test/v1/order-centers/" + path.join("/") + "?q=%25_%E5%BC%A0",
    );
  });
  it("checks strict assignment and source evidence and same origin without replaying writes", async () => {
    expect((await POST(write(input, "https://other.test"), context())).status).toBe(403);
    expect((await POST(write(input, "http://web.test", "?tenantId=x"), context())).status).toBe(
      400,
    );
    for (const change of [
      { tenantId: id },
      { reason: "arbitrary private note" },
      { expectedSourceChecksum: "invalid" },
      { escalationUserId: id, escalationDelayMinutes: 1 },
    ])
      expect((await POST(write({ ...input, ...change }), context())).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    upstream.mockRejectedValue(new Error("Synthetic uncertain transport"));
    expect((await POST(write(), context())).status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]?.[1]?.method).toBe("POST");
  });
  it("accepts only the documented responsibility response without leaking unexpected fields", async () => {
    upstream.mockResolvedValueOnce(Response.json({ ...view(), rawBuyerData: "synthetic-private" }));
    const failed = await GET(new Request(url), context());
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("synthetic-private");
    upstream.mockResolvedValueOnce(Response.json(view()));
    expect((await POST(write(), context())).status).toBe(200);
  });
  it.each([401, 403, 404])(
    "keeps denied reads private and does not expose upstream payload for %s",
    async (status) => {
      upstream.mockResolvedValue(new Response("synthetic-private", { status }));
      const result = await GET(new Request(url), context());
      expect(result.status).toBe(status);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(await result.text()).not.toContain("synthetic-private");
    },
  );
  it("validates every inbox query including dates and duplicate scope and disallows inbox writes", async () => {
    const tasks = "http://web.test/api/order-centers/tasks";
    for (const query of [
      "?tenantId=x",
      "?assignment=mine&assignment=visible",
      "?timeZone=invalid",
      "?status=closed&due=overdue",
      "?page=0",
      "?pageSize=101",
    ])
      expect((await GET(new Request(tasks + query), context(["tasks"]))).status).toBe(400);
    expect((await POST(new Request(tasks, { method: "POST" }), context(["tasks"]))).status).toBe(
      404,
    );
    expect(upstream).not.toHaveBeenCalled();
    upstream.mockResolvedValue(Response.json(list()));
    const result = await GET(
      new Request(tasks + "?assignment=unassigned&timeZone=UTC"),
      context(["tasks"]),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(upstream.mock.calls[0]?.[0]).toBe(
      "http://api.test/v1/order-centers/tasks?assignment=unassigned&timeZone=UTC",
    );
  });
  it("rejects malformed inbox payloads and cancels an obsolete list request without another attempt", async () => {
    const tasks = "http://web.test/api/order-centers/tasks";
    upstream.mockResolvedValueOnce(Response.json({ ...list(), privateField: "synthetic-private" }));
    expect((await GET(new Request(tasks), context(["tasks"]))).status).toBe(502);
    const abort = new AbortController();
    upstream.mockImplementationOnce(async (_url, init) => {
      abort.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new Error("Synthetic cancellation");
    });
    expect(
      (await GET(new Request(tasks, { signal: abort.signal }), context(["tasks"]))).status,
    ).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
