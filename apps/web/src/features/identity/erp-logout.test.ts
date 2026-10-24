import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmErpLogout } from "./erp-logout";
afterEach(() => vi.unstubAllGlobals());
describe("original logout acknowledgement", () => {
  it("keeps logout unconfirmed until the actual successful response body reaches EOF", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { status: 200 });
    const request = vi.fn(async () => response); vi.stubGlobal("fetch", request);
    let settled = false; const pending = confirmErpLogout().then(() => { settled = true; });
    await Promise.resolve(); stream.enqueue(new TextEncoder().encode('{"signedOut":true}'));
    await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
    expect(request).toHaveBeenCalledWith("/api/erp-auth/logout", expect.objectContaining({ method: "POST", cache: "no-store", signal: expect.any(AbortSignal) }));
    stream.close(); await pending; expect(settled).toBe(true);
  });
  it("rejects failed malformed and unconfirmed bodies instead of authorizing navigation", async () => {
    for (const response of [new Response('{"signedOut":true}', { status: 503 }), new Response("incomplete", { status: 200 }),
      new Response('{"signedOut":false}'), new Response('{"signedOut":"true"}'), new Response("null")]) {
      vi.stubGlobal("fetch", vi.fn(async () => response)); await expect(confirmErpLogout()).rejects.toBeInstanceOf(Error);
    }
  });
});
