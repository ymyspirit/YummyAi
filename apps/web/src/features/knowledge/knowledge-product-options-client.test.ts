import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { readKnowledgeProductOptions } from "./knowledge-product-options-client";
import { knowledgeReadDenied } from "./knowledge-api";

const authority = "synthetic-current-authority";
const payload = () => ({ contextAuthority: authority,
  items: [{ id: createEntityId(), code: "SYNTHETIC-PILLOW", name: "Synthetic shaped pillow" }], hasMore: false, limit: 40 });
const response = (value: unknown, header = authority, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", "x-yummyai-context-authority": header },
});
afterEach(() => vi.unstubAllGlobals());

describe("current-authority knowledge product candidates", () => {
  it("uses one bounded native GET with an explicit trimmed query and no caller-selected scope or limit", async () => {
    const body = payload(), fetcher = vi.fn().mockResolvedValue(response(body)); vi.stubGlobal("fetch", fetcher);
    expect(await readKnowledgeProductOptions("  pillow & pet  ", authority)).toEqual(body);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("/api/knowledge/product-options?q=pillow+%26+pet");
    expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", credentials: "same-origin",
      headers: { "x-yummyai-context-authority": authority } });
    expect(options.body).toBeUndefined();
  });

  it.each(["header", "body"])("rejects a different response %s authority instead of adopting its products", async mismatch => {
    const body = payload(); if (mismatch === "body") body.contextAuthority = "different-person";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body, mismatch === "header" ? "different-person" : authority)));
    await expect(readKnowledgeProductOptions("", authority)).rejects.toMatchObject({ status: 409, code: "authority_changed" });
  });

  it("rejects duplicate IDs, unsupported extra fields and an untrue bounded-page claim", async () => {
    const body = payload();
    for (const invalid of [{ ...body, items: [body.items[0], body.items[0]] }, { ...body, anotherTenant: "forged" }, { ...body, hasMore: true }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(invalid)));
      await expect(readKnowledgeProductOptions("", authority)).rejects.toMatchObject({ status: 502 });
    }
  });

  it("does not issue a request for a cleared signal or an overlong search", async () => {
    const fetcher = vi.fn(), abort = new AbortController(); vi.stubGlobal("fetch", fetcher); abort.abort();
    await expect(readKnowledgeProductOptions("", authority, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(readKnowledgeProductOptions("x".repeat(201), authority)).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a late body after its document cleared, even if the underlying mock still delivers valid JSON", async () => {
    const body = JSON.stringify(payload()), bytes = new TextEncoder().encode(body), abort = new AbortController();
    let finish: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, 5)); finish = () => { controller.enqueue(bytes.slice(5)); controller.close(); };
    } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { headers: { "x-yummyai-context-authority": authority } })));
    const reading = readKnowledgeProductOptions("", authority, abort.signal);
    await Promise.resolve(); abort.abort(); finish();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps an actual denial authoritative even when its error body is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON", { status: 403 })));
    try { await readKnowledgeProductOptions("", authority); throw new Error("denial_expected"); }
    catch (failure) { expect(knowledgeReadDenied(failure)).toBe(true); expect(failure).toMatchObject({ status: 403 }); }
  });
});
