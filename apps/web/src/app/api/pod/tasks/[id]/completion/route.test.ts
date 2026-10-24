import { beforeEach, afterEach, it, expect, vi } from "vitest";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../../../server-api", () => ({ apiFetch: upstream }));
import { GET } from "./route";
const id = "019f0000-0000-7000-8000-000000000001", other = "019f0000-0000-7000-8000-000000000002";
const context = (taskId = id) => ({ params: Promise.resolve({ id: taskId }) });
const request = () => new Request(`http://web.test/api/pod/tasks/${id}/completion`);
function record(taskId = id) { return { checksum: "a".repeat(64), evidence: { contractVersion:"pod-completion-v1",taskId,designTaskId:other,toolKey:"pattern_crop",inputFingerprint:"a".repeat(64),methodContractChecksum:null,methodValidation:"legacy_missing",responseChecksum:"b".repeat(64),decodedWith:"pod-processor-result-v1",resultVersionId:other,resultState:"awaiting_review",qualityCheckChecksum:"c".repeat(64),outputs:[{ordinal:0,assetId:other,assetVersion:1,checksumSha256:"d".repeat(64),byteSize:5,mediaType:"image/png",role:"effect"}],requiresBusinessReview:true,automaticProductionApproval:false } }; }
beforeEach(() => { vi.stubEnv("API_BASE_URL","http://api.test"); upstream.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
it("validates original identity and performs a fresh authenticated read before returning a private download", async () => {
  expect((await GET(request(),context("invalid"))).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  upstream.mockResolvedValueOnce(Response.json(record()));
  const response = await GET(request(),context());
  expect(response.status).toBe(200); expect(await response.json()).toEqual(record());
  expect(upstream).toHaveBeenCalledWith(`http://api.test/v1/pod/tasks/${id}/completion`,expect.objectContaining({cache:"no-store"}));
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-disposition")).toContain(`pod-completion-${id}.json`);
});
it("preserves current denial and missing-history status without forwarding upstream bodies", async () => {
  for (const status of [401,403,404,409,410,500]) {
    upstream.mockResolvedValueOnce(Response.json({private:"synthetic upstream detail"},{status}));
    const response = await GET(request(),context());
    expect(response.status).toBe(status===500?502:status); expect(await response.text()).not.toContain("upstream detail");
  }
});
it("rejects another task or automatic approval instead of downloading malformed evidence", async () => {
  const malformed=record(); malformed.evidence.automaticProductionApproval=true;
  for(const payload of [record(other),malformed,{checksum:"a".repeat(64)}]) {
    upstream.mockResolvedValueOnce(Response.json(payload));expect((await GET(request(),context())).status).toBe(502);
  }
});
