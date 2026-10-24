import { createEntityId } from "@yummyai/contracts";
import { AssistReceiptViewSchema } from "@yummyai/contracts/ai/assist-recovery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistJsonRequest, assistReadDenied } from "./assist-client";

const fetchMock = vi.fn<typeof fetch>();
const authority = "synthetic current authority";
const receipt = { version: "assist-request-receipt-v1", contextAuthority: authority, requestId: createEntityId(), requestChecksum: "a".repeat(64), state: "not_found", run: null };

describe("Assist client authority and uncertain transport", () => {
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("clears private state only for real denial or literal authority_changed and preserves ordinary conflicts for original recovery", async () => {
    for (const code of ["authority_changed", "agent_collection_changed", null] as const) {
      fetchMock.mockResolvedValueOnce(Response.json({ code, message: "synthetic-private-server-detail" }, { status: 409 }));
      const error = await assistJsonRequest("/synthetic-receipt", AssistReceiptViewSchema, undefined, undefined, authority).catch(cause => cause);
      expect(assistReadDenied(error)).toBe(code === "authority_changed"); expect(error.message).not.toContain("synthetic-private-server-detail");
    }
    fetchMock.mockResolvedValueOnce(Response.json(receipt, { headers: { "x-yummyai-context-authority": "old authority" } }));
    const mismatch = await assistJsonRequest("/synthetic-receipt", AssistReceiptViewSchema, undefined, undefined, authority).catch(cause => cause);
    expect(assistReadDenied(mismatch)).toBe(true);
  });

  it("keeps network loss uncertain, performs one request and verifies the current authority and response DTO", async () => {
    fetchMock.mockRejectedValueOnce(new Error("synthetic transport private detail"));
    await expect(assistJsonRequest("/synthetic-receipt", AssistReceiptViewSchema, undefined, undefined, authority)).rejects.toMatchObject({ status: 0, code: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(Response.json({ ...receipt, result: "substituted private body" }, { headers: { "x-yummyai-context-authority": authority } }));
    await expect(assistJsonRequest("/synthetic-receipt", AssistReceiptViewSchema, undefined, undefined, authority)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(Response.json(receipt, { headers: { "x-yummyai-context-authority": authority } }));
    expect(await assistJsonRequest("/synthetic-receipt", AssistReceiptViewSchema, undefined, undefined, authority)).toEqual(receipt);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});
