import { createEntityId } from "@yummyai/contracts/common/ids";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { api } = vi.hoisted(() => ({ api: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: api }));
import { GET } from "./route";
import { WorkflowTaskInboxQuerySchema } from "@yummyai/contracts/workflow/task-inbox";
const run = createEntityId(),
  artifact = createEntityId();
const read = (path: string[], query = "") =>
  GET(new Request(`http://web.test/api/workflow-runs/${path.join("/")}${query}`), {
    params: Promise.resolve({ path }),
  });
beforeEach(() => {
  api.mockReset();
  process.env.API_BASE_URL = "http://api.test";
});
describe("workflow operator read proxy", () => {
  it("reads the private assignment inbox with server totals and no posted tenant scope", async () => {
    const query = WorkflowTaskInboxQuerySchema.parse({ assignment: "visible", timeZone: "Asia/Shanghai", page: 4 });
    api.mockResolvedValueOnce(Response.json({ source: "workflow", asOf: new Date().toISOString(), query, total: 63, page: 4, pageSize: 25, items: [], summary: { overdue: 30, dueToday: 8, blocked: 2, upcoming: 9, unassigned: 4 } }));
    const response = await read(["tasks"], "?assignment=visible&timeZone=Asia%2FShanghai&page=4");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ total: 63, summary: { overdue: 30 } });
    expect(String(api.mock.calls[0]?.[0])).toContain("/v1/workflow-runs/tasks?");
  });
  it.each(["?tenantId=forged", "?userId=forged", "?assignment=other", "?page=NaN", "?pageSize=101", "?status=closed&due=overdue", "?timeZone=not-a-zone", "?assignment=mine&assignment=visible"])("rejects invalid inbox scope and filters %s", async (query) => {
    expect((await read(["tasks"], query)).status).toBe(400); expect(api).not.toHaveBeenCalled();
  });
  it.each([
    ["not-a-run"],
    [run, "commands"],
    [run, "nodes", "..", "execution"],
    [run, "artifacts", "wrong", "file"],
    [run, "nodes", "a/b", "execution"],
  ])("rejects paths outside the fixed read boundary %j", async (...parts) => {
    const response = await read(parts);
    expect(response.status).toBe(404);
    expect(api).not.toHaveBeenCalled();
  });
  it("allows only source-search query parameters on repair options", async () => {
    expect((await read([run], "?tenantId=forged")).status).toBe(400);
    expect(api).not.toHaveBeenCalled();
    api.mockResolvedValueOnce(
      Response.json({
        kind: "profile",
        targetMarketplace: "amazon.com",
        researchSnapshotId: null,
        sources: [],
        hasMoreSources: false,
      }),
    );
    expect((await read([run, "nodes", "work", "repair-options"], "?q=Custom%20Mug")).status).toBe(
      200,
    );
    expect(String(api.mock.calls[0]?.[0])).toContain("q=Custom+Mug");
  });
  it("removes unknown private metadata and masks upstream failures", async () => {
    api.mockResolvedValueOnce(
      Response.json({
        runId: run,
        nodeId: "work",
        inspectedAt: new Date().toISOString(),
        access: { canCommand: false, canApprove: false, canRepair: false, canRetry: false },
        attempts: [],
        hasMoreAttempts: false,
        secret: "private",
      }),
    );
    const response = await read([run, "nodes", "work", "execution"]);
    expect(await response.json()).not.toHaveProperty("secret");
    api.mockResolvedValueOnce(
      Response.json({ message: "secret raw provider error" }, { status: 500 }),
    );
    expect(await (await read([run])).text()).not.toContain("secret");
    api.mockResolvedValueOnce(Response.json({ objectKey: "private-location" }));
    expect((await read([run])).status).toBe(502);
  });
  it("streams an authenticated ZIP with private attachment headers and rejects signed-URL redirects", async () => {
    api.mockResolvedValueOnce(
      new Response(new Uint8Array([80, 75, 3, 4]), {
        headers: {
          "content-type": "application/zip",
          "content-disposition": "attachment; filename=fixture.zip",
        },
      }),
    );
    const response = await read([run, "artifacts", artifact, "file"]);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([80, 75, 3, 4]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=fixture.zip");
    api.mockResolvedValueOnce(
      new Response("signed storage URL", { headers: { "content-type": "text/plain" } }),
    );
    expect((await read([run, "artifacts", artifact, "file"])).status).toBe(502);
  });
});
