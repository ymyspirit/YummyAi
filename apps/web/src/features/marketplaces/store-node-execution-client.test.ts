import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoreNodeExecution, readStoreNodeExecutionReceipt, readStoreNodeExecutionWorkspace, storeNodeExecutionDenied, StoreNodeExecutionError,
  verifyStoreNodeExecutionHistory, verifyStoreNodeExecutionView } from "./store-node-execution-client";
import { executionAuthority, executionContext, executionIds, executionInput, executionReceipt, executionResponse, executionView, executionWorkspace } from "./store-node-execution.test-fixture";

afterEach(() => vi.unstubAllGlobals());
describe("personal node execution browser transport", () => {
  it("requires matching current response authority and member identity for the independent workspace", async () => {
    const wrong = executionWorkspace(); wrong.context.actorId = executionIds.other;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(executionResponse(executionWorkspace())).mockResolvedValueOnce(executionResponse(wrong))
      .mockResolvedValueOnce(Response.json(executionWorkspace(), { headers: { "x-yummyai-context-authority": "f".repeat(64) } }));
    vi.stubGlobal("fetch", fetcher);
    expect((await readStoreNodeExecutionWorkspace(executionContext)).binding.online).toBe(false);
    await expect(readStoreNodeExecutionWorkspace(executionContext)).rejects.toMatchObject({ status: 409, code: "authority_changed" });
    await expect(readStoreNodeExecutionWorkspace(executionContext)).rejects.toMatchObject({ status: 409, code: "authority_changed" });
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get("x-yummyai-context-authority")).toBe(executionAuthority);
  });
  it("binds the original account, full input and exact task snapshot without substituting the newest result", async () => {
    const valid = executionView(true); await expect(verifyStoreNodeExecutionView(valid, executionIds.account)).resolves.toBeUndefined();
    await expect(verifyStoreNodeExecutionView(valid, executionIds.other)).rejects.toMatchObject({ status: 502 });
    const wrongInput = executionView(); wrongInput.input.amazonProductTypes = ["PILLOW"];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(executionResponse(wrongInput, 201)); vi.stubGlobal("fetch", fetcher);
    await expect(createStoreNodeExecution(executionContext, executionInput())).rejects.toMatchObject({ status: 502, submitted: true });
    const wrongSnapshot = executionView(true); wrongSnapshot.snapshot!.id = executionIds.other;
    await expect(verifyStoreNodeExecutionView(wrongSnapshot, executionIds.account)).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps a lost creation unknown and recovers through the read-only receipt without retrying the creation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("synthetic lost response"))
      .mockResolvedValueOnce(executionResponse(executionReceipt(false))).mockResolvedValueOnce(executionResponse(executionReceipt()));
    vi.stubGlobal("fetch", fetcher);
    await expect(createStoreNodeExecution(executionContext, executionInput())).rejects.toMatchObject({ status: 0, submitted: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const query = { requestId: executionIds.request, requestChecksum: executionInput().requestChecksum };
    expect((await readStoreNodeExecutionReceipt(executionContext, query)).found).toBe(false);
    expect((await readStoreNodeExecutionReceipt(executionContext, query)).execution?.id).toBe(executionIds.execution);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/node-executions"))).toHaveLength(1);
    expect(fetcher.mock.calls.slice(1).every(([url]) => String(url).endsWith("/receipt"))).toBe(true);
  });
  it("does not confuse an invalid history page or a binding conflict with an authority denial", () => {
    const page = { protocol: "erp-store-node-execution-v1" as const, accountId: executionIds.account, items: [], nextCursor: executionIds.execution, hasMore: true };
    expect(() => verifyStoreNodeExecutionHistory(page, executionIds.account)).toThrow();
    expect(() => verifyStoreNodeExecutionHistory({ ...page, nextCursor: null, hasMore: false }, executionIds.account)).not.toThrow();
    expect(storeNodeExecutionDenied(new StoreNodeExecutionError(409, "store_node_binding_changed"))).toBe(false);
    expect(storeNodeExecutionDenied(new StoreNodeExecutionError(409, "store_node_authority_changed"))).toBe(true);
  });
});
