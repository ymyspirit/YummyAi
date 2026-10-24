import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoreNodeEnrollment, readStoreNodes } from "./store-node-actions";
import { nodeAuthority, nodeContext, nodeCreated, nodeInput, nodeIds, nodeResponse, nodeWorkspace } from "./store-node.test-fixture";

afterEach(() => { vi.unstubAllGlobals(); });
describe("store node browser transport", () => {
  it("only admits a bounded current-authority workspace and refuses a different owner or response stamp", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(nodeResponse(nodeWorkspace()))
      .mockResolvedValueOnce(nodeResponse({ ...nodeWorkspace(), context: { ...nodeWorkspace().context, actorId: nodeIds.other } }))
      .mockResolvedValueOnce(Response.json(nodeWorkspace(), { headers: { "x-yummyai-context-authority": "f".repeat(64) } }));
    vi.stubGlobal("fetch", fetcher);
    expect((await readStoreNodes(nodeContext)).accountId).toBe(nodeContext.accountId);
    await expect(readStoreNodes(nodeContext)).rejects.toMatchObject({ status: 409, code: "authority_changed" });
    await expect(readStoreNodes(nodeContext)).rejects.toMatchObject({ status: 409, code: "authority_changed" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get("x-yummyai-context-authority")).toBe(nodeAuthority);
  });
  it("binds a first-use ticket response to the submitted public key, original key and node generation", async () => {
    const wrong = nodeCreated(); wrong.enrollment.publicKeySpkiSha256 = "f".repeat(64);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(nodeResponse(nodeCreated(), 201)).mockResolvedValueOnce(nodeResponse(wrong, 201));
    vi.stubGlobal("fetch", fetcher);
    const result = await createStoreNodeEnrollment(nodeContext, nodeInput);
    expect(result.enrollment.nodeId).toBe(nodeIds.node); expect(result.enrollment.certificateGeneration).toBe(1);
    expect(Boolean(result.enrollment.ticketToken)).toBe(true);
    await expect(createStoreNodeEnrollment(nodeContext, nodeInput)).rejects.toMatchObject({ status: 502, submitted: true });
    const sent = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)) as typeof nodeInput;
    expect(sent.idempotencyKey).toBe(nodeInput.idempotencyKey); expect(sent.publicKeyPem).toBe(nodeInput.publicKeyPem);
  });
  it("never retries an unknown POST automatically and preserves the exact body for explicit same-key retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("synthetic delivery loss"))
      .mockResolvedValueOnce(nodeResponse({ code: "store_node_ticket_not_replayable" }, 409)).mockResolvedValueOnce(nodeResponse(nodeWorkspace()));
    vi.stubGlobal("fetch", fetcher);
    await expect(createStoreNodeEnrollment(nodeContext, nodeInput)).rejects.toMatchObject({ status: 0, submitted: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(createStoreNodeEnrollment(nodeContext, nodeInput)).rejects.toMatchObject({ status: 409, code: "store_node_ticket_not_replayable" });
    expect(fetcher.mock.calls[0]![1]!.body).toBe(fetcher.mock.calls[1]![1]!.body);
    const restored = await readStoreNodes(nodeContext);
    expect(restored.nodes.filter(node => node.creationRequestKey === nodeInput.idempotencyKey)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3); expect(fetcher.mock.calls[2]![1]!.method).toBe("GET");
  });
});
