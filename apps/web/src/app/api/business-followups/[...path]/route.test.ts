import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FollowupTaskInboxQuerySchema } from "@yummyai/contracts/operations/followup";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";
const id = "019f0000-0000-7000-8000-000000000001",
  source = "procurement_order",
  url = `http://web.test/api/business-followups/${source}/${id}`;
const context = (path = [source, id]) => ({ params: Promise.resolve({ path }) });
const input = {
  expectedRevision: 0,
  expectedSourceChecksum: "a".repeat(64),
  assignedUserId: id,
  dueAt: null,
  escalationUserId: null,
  escalationDelayMinutes: null,
  reason: "initial_assignment",
};
const value = {
  objectId: id,
  source,
  revision: 1,
  assignmentRevision: 1,
  currentTask: "跟进采购审核",
  sourceChecksum: "a".repeat(64),
  active: true,
  available: true,
  businessVersion: 1,
  reminderCycle: 1,
  lastReason: "initial_assignment",
  canResume: false,
  assignedUserId: id,
  assignedUserName: "Synthetic",
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
};
const request = (body: unknown = input, origin = "http://web.test", query = "") =>
  new Request(url + "/responsibility" + query, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
describe("business follow-up proxy boundaries", () => {
  beforeEach(() => {
    upstream.mockReset();
    vi.stubEnv("API_BASE_URL", "http://api.test");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("rejects unknown sources, arbitrary paths, duplicate criteria and caller-controlled tenant scope", async () => {
    for (const path of [
      ["orders", id],
      [source, id, "delete"],
      [source, "not-an-id"],
      [source, id, "responsibility", "extra"],
    ])
      expect((await GET(new Request(url), context(path))).status).toBe(404);
    for (const query of ["?tenantId=x", "?q=a&q=b", "?q=" + "a".repeat(101)])
      expect((await GET(new Request(url + query), context())).status).toBe(400);
    for (const query of [
      "?assignment=other",
      "?q=a&q=b",
      "?userId=" + id,
      "?timeZone=invalid",
      "?status=closed&due=today",
    ])
      expect((await GET(new Request(url + query), context([source, "tasks"]))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("bounds same-origin writes and disallows private reason text, extra fields and invalid escalation", async () => {
    expect(
      (await POST(request(input, "https://other.test"), context([source, id, "responsibility"])))
        .status,
    ).toBe(403);
    for (const patch of [
      { tenantId: id },
      { reason: "private buyer note" },
      { expectedSourceChecksum: "bad" },
      { escalationUserId: id, escalationDelayMinutes: 1 },
    ])
      expect(
        (await POST(request({ ...input, ...patch }), context([source, id, "responsibility"])))
          .status,
      ).toBe(400);
    expect(
      (await POST(request(input, "http://web.test", "?q=x"), context([source, id, "resume"])))
        .status,
    ).toBe(400);
    expect(
      (await POST(request("a".repeat(9000)), context([source, id, "responsibility"]))).status,
    ).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("never retries an uncertain write and preserves the explicit resume destination", async () => {
    upstream.mockRejectedValueOnce(new Error("uncertain"));
    expect((await POST(request(), context([source, id, "responsibility"]))).status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);
    upstream.mockResolvedValueOnce(Response.json(value));
    const response = await POST(request(), context([source, id, "resume"]));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(upstream.mock.calls[1]![0]).toBe(
      `http://api.test/v1/business-followups/${source}/${id}/resume`,
    );
  });
  it("validates upstream shapes and never forwards unexpected private fields", async () => {
    upstream.mockResolvedValueOnce(Response.json({ ...value, buyer: "synthetic-private" }));
    const response = await POST(request(), context([source, id, "responsibility"]));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("synthetic-private");
    upstream.mockResolvedValueOnce(
      Response.json({
        source,
        asOf: "2026-10-16T00:00:00Z",
        query: FollowupTaskInboxQuerySchema.parse({}),
        items: [],
        total: 0,
        page: 1,
        pageSize: 25,
        summary: { overdue: 0, dueToday: 0, attention: 0, unassigned: 0, unavailable: 0 },
      }),
    );
    expect(
      (await GET(new Request(url + "?q=%25_%E5%BC%A0"), context([source, "tasks"]))).status,
    ).toBe(200);
    expect(upstream.mock.calls[1]![0]).toBe(
      `http://api.test/v1/business-followups/${source}/tasks?q=%25_%E5%BC%A0`,
    );
  });
});
