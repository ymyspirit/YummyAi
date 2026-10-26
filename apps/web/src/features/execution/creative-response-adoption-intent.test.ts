import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER, CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER,
  CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER, CREATIVE_RESPONSE_ADOPTION_PREVIEW_MAX_BYTES,
  CreativeResponseAdoptionRequestViewSchema, CreativeResponseAdoptionWorkspaceSchema,
  type CreativeResponseAdoptionCommand, type CreativeResponseAdoptionRequestView,
} from "@yummyai/contracts/harness/creative-response-adoption";
import { createCreativeResponseAdoptionClient } from "./creative-response-adoption-client";
import { clearCreativeResponseAdoptionIntents, createCreativeResponseAdoptionIntent, CREATIVE_RESPONSE_ADOPTION_INTENT_PREFIX,
  type CreativeResponseAdoptionStorage } from "./creative-response-adoption-intent";

const ids = { execution: "019a0000-0000-7000-8000-000000000001", adoption: "019a0000-0000-7000-8000-000000000002",
  candidate: "019a0000-0000-7000-8000-000000000003", batch: "019a0000-0000-7000-8000-000000000004",
  asset: "019a0000-0000-7000-8000-000000000005", other: "019a0000-0000-7000-8000-000000000006" };
const basis = "a".repeat(64), responseChecksum = "b".repeat(64), identity = "c".repeat(64), authority = "d".repeat(64);
const requestId = "00000000-0000-4000-8000-000000000001", secondRequestId = "00000000-0000-4000-8000-000000000002";
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const artifactChecksum = createHash("sha256").update(png).digest("hex");
const command = (): CreativeResponseAdoptionCommand => ({ requestId, expectedBasis: basis, acknowledgeReviewRequired: true });
const stamp = "2026-10-24T00:00:00.000Z";
function view(input = command(), status: "prepared" | "processing" | "committed" | "cancelled" = "committed") {
  return CreativeResponseAdoptionRequestViewSchema.parse({ id: ids.adoption, executionId: ids.execution, requestId: input.requestId, command: input,
    status, attempts: 1, leaseActive: status === "processing", canRetry: status === "prepared", canCancel: status === "prepared",
    errorCode: status === "prepared" ? "CREATIVE_ADOPTION_ARTIFACT_IO_FAILED" : null,
    artifactCleanup: status === "committed" ? "registered" : "not_required", createdAt: stamp, updatedAt: stamp,
    receipt: status === "committed" ? { version: "creative-response-adoption-v1", id: ids.adoption, executionId: ids.execution, requestId: input.requestId,
      basis: input.expectedBasis, candidateId: ids.candidate, originalPhase: "failed", inputFingerprint: "e".repeat(64), responseChecksum,
      encryptedChecksum: "f".repeat(64), artifact: { assetId: ids.asset, version: 1, checksumSha256: artifactChecksum, mediaType: "image/png", width: 1, height: 1 },
      modelKey: "synthetic-original", modelVersion: "v1", originalCostUsd: null, disposition: "generated", rightsStatus: "unverified",
      approval: "review_required", committedAt: stamp } : null });
}
function workspace(requests: CreativeResponseAdoptionRequestView[] = []) {
  return CreativeResponseAdoptionWorkspaceSchema.parse({ version: "creative-response-adoption-v1", executionId: ids.execution,
    candidateId: ids.candidate, batchId: ids.batch, identityStamp: identity, kind: "creative_candidate", stepKey: "generate", originalPhase: "failed",
    candidateStatus: "failed", basis, canInspectOriginal: true, canAdopt: true, blockers: [], source: { inputFingerprint: "e".repeat(64),
      responseChecksum, encryptedChecksum: "f".repeat(64), archiveState: "registered_unverified", archiveExpiresAt: "2026-10-31T00:00:00.000Z",
      providerRequestId: "synthetic-original-request", receivedAt: stamp, modelKey: "synthetic-original", modelVersion: "v1", originalCostUsd: null, providerInvoiceVerified: false },
    requests, noNewModelCall: true, resultRequiresReview: true });
}
const headers = () => new Headers({ "x-yummyai-context-authority": authority, "content-type": "application/json" });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: headers() });
function previewResponse(patch: Record<string, string> = {}, body = png) {
  const responseHeaders = new Headers({ "x-yummyai-context-authority": authority, "content-type": "image/png", "content-length": String(body.length),
    [CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER]: basis, [CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER]: responseChecksum,
    [CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER]: artifactChecksum, ...patch });
  return new Response(Uint8Array.from(body), { headers: responseHeaders });
}
class MemoryStorage implements CreativeResponseAdoptionStorage {
  readonly values = new Map<string, string>();
  writes = 0; failWrite = false; discardWrite = false;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes++; if (this.failWrite) throw new Error("synthetic storage denied"); if (!this.discardWrite) this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function client(fetch: typeof globalThis.fetch, current: () => void = () => {}) {
  return createCreativeResponseAdoptionClient({ executionId: ids.execution, authority, signal: new AbortController().signal, current, fetch });
}
function harness(storage = new MemoryStorage()) {
  const state: { indexed: CreativeResponseAdoptionRequestView[]; lookup: CreativeResponseAdoptionRequestView | null; postError?: Error;
    cancelResult?: CreativeResponseAdoptionRequestView; active: boolean } =
    { indexed: [], lookup: null, active: true };
  const posts: Array<{ path: string; body: unknown }> = [], gets: string[] = [];
  const current = () => { if (!state.active) throw new Error("synthetic_owner_cleared"); };
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    if (init?.method === "POST") {
      const body: unknown = JSON.parse(String(init.body)); posts.push({ path, body });
      if (path.endsWith("/cancel")) {
        state.lookup = state.cancelResult ?? view(command(), "cancelled"); state.indexed = [state.lookup];
        if (state.postError) throw state.postError;
        return json(state.lookup);
      }
      const request = body as CreativeResponseAdoptionCommand;
      const committed = view(request); state.lookup = committed; state.indexed = [committed];
      if (state.postError) throw state.postError;
      return json(committed);
    }
    gets.push(path);
    if (path.includes("/preview?")) return previewResponse();
    if (path.includes("/by-request/")) return state.lookup ? json(state.lookup) : json({ code: "not_found" }, 404);
    return json(workspace(state.indexed));
  });
  let generated = 0;
  const session = () => createCreativeResponseAdoptionIntent({ executionId: ids.execution, client: client(transport, current), storage, current,
    id: () => { generated++; return generated === 1 ? requestId : secondRequestId; } });
  return { storage, state, posts, gets, transport, session, generated: () => generated };
}
async function inspected(session: ReturnType<ReturnType<typeof harness>["session"]>) {
  await session.read(); const preview = await session.inspect(); session.previewLoaded(preview.basis, preview.artifactChecksum); return preview;
}

describe("creative response adoption real transport validation", () => {
  it("verifies the distinct archive-response and actual image byte checksums with original authority", async () => {
    const transport = vi.fn<typeof fetch>(async () => previewResponse());
    const preview = await client(transport).preview(workspace());
    expect(preview.responseChecksum).toBe(responseChecksum); expect(preview.artifactChecksum).toBe(artifactChecksum);
    expect(artifactChecksum).not.toBe(responseChecksum); expect(new Uint8Array(await preview.blob.arrayBuffer())).toEqual(png);
    expect(transport).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0]!;
    expect(String(url)).toBe("/api/creative-executions/" + ids.execution + "/response-adoption/preview?basis=" + basis);
    expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(new Headers(init!.headers).get("x-yummyai-context-authority")).toBe(authority);
  });

  it.each([CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER, CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER,
    CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER, "content-type"])("rejects mismatched %s before reading the preview body", async header => {
    let reads = 0; const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(png); controller.close(); }, cancel }, { highWaterMark: 0 });
    const h = previewResponse().headers;
    h.set(header, header === "content-type" ? "text/plain" : header === CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER ? "not-a-sha256" : "0".repeat(64));
    const transport = vi.fn<typeof fetch>(async () => new Response(body, { headers: h }));
    await expect(client(transport).preview(workspace())).rejects.toMatchObject({ status: 502 });
    expect(reads).toBe(0); expect(cancel).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects bytes that do not hash to the pinned image artifact even with HTTP 200 and valid envelope headers", async () => {
    const changed = Uint8Array.from(png); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    await expect(client(vi.fn<typeof fetch>(async () => previewResponse({}, changed))).preview(workspace())).rejects.toMatchObject({ status: 502 });
  });

  it("rejects declared oversized images before consuming bytes and cancels oversized streamed metadata", async () => {
    const cancelled = vi.fn(); let reads = 0;
    const h = previewResponse().headers; h.set("content-length", String(CREATIVE_RESPONSE_ADOPTION_PREVIEW_MAX_BYTES + 1));
    const stream = new ReadableStream<Uint8Array>({ pull() { reads++; }, cancel: cancelled }, { highWaterMark: 0 });
    await expect(client(vi.fn<typeof fetch>(async () => new Response(stream, { headers: h }))).preview(workspace())).rejects.toMatchObject({ status: 413 });
    expect(reads).toBe(0); expect(cancelled).toHaveBeenCalledOnce();
    const cancelMetadata = vi.fn();
    const metadata = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); }, cancel: cancelMetadata }, { highWaterMark: 0 });
    await expect(client(vi.fn<typeof fetch>(async () => new Response(metadata, { headers: headers() }))).workspace()).rejects.toMatchObject({ status: 413 });
    expect(cancelMetadata).toHaveBeenCalledOnce();
  });

  it("rejects a truncated preview and a late owner-cleared response without accepting partial or private bytes", async () => {
    await expect(client(vi.fn<typeof fetch>(async () => previewResponse({ "content-length": String(png.length + 1) }))).preview(workspace())).rejects.toMatchObject({ status: 502 });
    const held = deferred<Response>(), cancelled = vi.fn(); let active = true, reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(png); controller.close(); }, cancel: cancelled }, { highWaterMark: 0 });
    const pending = client(vi.fn<typeof fetch>(async () => held.promise), () => { if (!active) throw new Error("synthetic_owner_cleared"); }).preview(workspace());
    active = false; held.resolve(new Response(stream, { headers: previewResponse().headers }));
    await expect(pending).rejects.toThrow("synthetic_owner_cleared"); expect(reads).toBe(0); expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each(["execution", "command", "cancel-id"] as const)("rejects a 200 receipt with the wrong %s without transport retry", async field => {
    const original = view(), wrong = JSON.parse(JSON.stringify(original)) as CreativeResponseAdoptionRequestView;
    if (field === "execution") { wrong.executionId = ids.other; wrong.receipt!.executionId = ids.other; }
    if (field === "command") { wrong.command.expectedBasis = "9".repeat(64); wrong.receipt!.basis = "9".repeat(64); }
    if (field === "cancel-id") { wrong.id = ids.other; wrong.receipt!.id = ids.other; }
    const transport = vi.fn<typeof fetch>(async () => json(wrong)), c = client(transport);
    await expect(field === "cancel-id" ? c.cancel(original) : c.adopt(command())).rejects.toMatchObject({ status: 502 });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("treats an exact lookup 404 as unknown and never exposes a rejected server error body", async () => {
    const c = client(vi.fn<typeof fetch>(async () => json({ private: "synthetic-private-response-body" }, 404)));
    expect(await c.lookup(command())).toBeNull();
    await expect(c.adopt(command())).rejects.toMatchObject({ status: 404 });
    await expect(c.adopt(command())).rejects.not.toThrow("synthetic-private-response-body");
  });
});

describe("creative response adoption durable intent and read-only recovery", () => {
  it.each(["throw", "discard"] as const)("does not POST when local intent storage will %s the exact original command", async mode => {
    const h = harness(), session = h.session(); await inspected(session);
    h.storage.failWrite = mode === "throw"; h.storage.discardWrite = mode === "discard";
    await expect(session.adopt(basis)).rejects.toThrow("浏览器未能保留"); expect(h.posts).toHaveLength(0);
  });

  it("requires actual preview load and matching basis before saving the command or submitting", async () => {
    const h = harness(), session = h.session(); await session.read();
    await expect(session.adopt(basis)).rejects.toThrow("完整查看");
    const preview = await session.inspect();
    await expect(session.adopt(basis)).rejects.toThrow("完整查看");
    expect(() => session.previewLoaded(basis, "0".repeat(64))).toThrow();
    session.previewLoaded(preview.basis, preview.artifactChecksum);
    await expect(session.adopt("0".repeat(64))).rejects.toThrow("完整查看");
    expect(h.posts).toHaveLength(0); expect(h.generated()).toBe(0); expect(h.storage.writes).toBe(0);
  });

  it("saves and reads back the immutable original marker before POST and restores a lost committed acknowledgement only by GET", async () => {
    const h = harness(), first = h.session(); await inspected(first);
    h.state.postError = new TypeError("synthetic lost acknowledgement");
    await expect(first.adopt(basis)).rejects.toThrow("synthetic lost acknowledgement");
    expect(h.posts).toEqual([{ path: "/api/creative-executions/" + ids.execution + "/response-adoptions", body: command() }]);
    const marker = [...h.storage.values.values()][0]!;
    expect(JSON.parse(marker)).toEqual({ executionId: ids.execution, identityStamp: identity, command: command() });
    expect(marker).not.toContain("synthetic-original-request"); expect(marker).not.toContain("dataBase64");
    await expect(first.retry(basis)).rejects.toThrow("尚未核对"); expect(h.posts).toHaveLength(1);
    const reloaded = h.session(), recovered = await reloaded.read();
    expect(recovered.request).toEqual(view()); expect(h.generated()).toBe(1); expect(h.posts).toHaveLength(1);
    expect(h.gets.at(-1)).toBe("/api/creative-executions/" + ids.execution + "/response-adoptions/by-request/" + requestId);
  });

  it("recovers the original server index after local marker loss without generating a new key or POST", async () => {
    const h = harness(); h.state.lookup = view(); h.state.indexed = [h.state.lookup];
    const recovered = await h.session().read();
    expect(recovered.intent!.command).toEqual(command()); expect(recovered.request).toEqual(view());
    expect(h.generated()).toBe(0); expect(h.posts).toHaveLength(0); expect(h.gets).toHaveLength(2);
  });

  it("keeps an unknown missing original key and rejects a replacement submit", async () => {
    const h = harness(), first = h.session(); await inspected(first); h.state.postError = new TypeError("synthetic pre-response disconnect");
    await expect(first.adopt(basis)).rejects.toThrow(); h.state.lookup = null; h.state.indexed = [];
    const next = h.session(), recovered = await next.read();
    expect(recovered.lookupMissing).toBe(true); expect(recovered.intent!.command).toEqual(command());
    const preview = await next.inspect(); next.previewLoaded(preview.basis, preview.artifactChecksum);
    await expect(next.adopt(basis)).rejects.toThrow("已有采用请求"); await expect(next.retry(basis)).rejects.toThrow("尚未核对");
    expect(h.generated()).toBe(1); expect(h.posts).toHaveLength(1);
  });

  it("requires fresh server retry permission after each unknown write and preserves the original full command", async () => {
    const h = harness(); h.state.lookup = view(command(), "prepared"); h.state.indexed = [h.state.lookup];
    const session = h.session(); await inspected(session); h.state.postError = new TypeError("synthetic second ACK loss");
    await expect(session.retry(basis)).rejects.toThrow("synthetic second ACK loss");
    expect(h.posts[0]!.body).toEqual(command()); await expect(session.retry(basis)).rejects.toThrow("尚未核对");
    expect(h.posts).toHaveLength(1); expect(h.generated()).toBe(0);
  });

  it("does not reuse preview approval after a read or accept a late preview from the previous read", async () => {
    const h = harness(), session = h.session(); await inspected(session); await session.read();
    await expect(session.adopt(basis)).rejects.toThrow("完整查看");
    const held = deferred<Response>(); h.transport.mockImplementationOnce(async () => held.promise);
    const preview = session.inspect(); await session.read(); held.resolve(previewResponse());
    await expect(preview).rejects.toThrow("迟到预览"); expect(h.posts).toHaveLength(0);
  });

  it("does not reconstruct a cleared intent or adopt a late owner response after logout", async () => {
    const h = harness(); h.state.lookup = view(command(), "prepared"); h.state.indexed = [h.state.lookup];
    const session = h.session(); await inspected(session);
    h.storage.setItem("unrelated", "keep"); clearCreativeResponseAdoptionIntents(h.storage);
    expect([...h.storage.values.keys()].some(key => key.startsWith(CREATIVE_RESPONSE_ADOPTION_INTENT_PREFIX))).toBe(false);
    expect(h.storage.getItem("unrelated")).toBe("keep"); await expect(session.retry(basis)).rejects.toThrow("已清除");
    const held = deferred<Response>(); h.transport.mockImplementationOnce(async () => held.promise);
    const reading = session.read(); h.state.active = false; held.resolve(json(workspace([view()])));
    await expect(reading).rejects.toThrow("synthetic_owner_cleared");
    expect([...h.storage.values.keys()].some(key => key.startsWith(CREATIVE_RESPONSE_ADOPTION_INTENT_PREFIX))).toBe(false);
    expect(h.posts).toHaveLength(0);
  });

  it("cancels only the exact read-proven request and refuses reuse of its cancelled command", async () => {
    const h = harness(); h.state.lookup = view(command(), "prepared"); h.state.indexed = [h.state.lookup];
    const session = h.session(); await inspected(session);
    expect((await session.cancel()).request).toEqual(view(command(), "cancelled"));
    expect(h.posts).toEqual([{ path: "/api/creative-executions/" + ids.execution + "/response-adoptions/" + ids.adoption + "/cancel", body: { requestId } }]);
    await expect(session.retry(basis)).rejects.toThrow("尚未核对"); expect(h.generated()).toBe(0);
  });

  it("explicitly retries cleanup of the exact cancelled pending artifact and stops after the complete receipt", async () => {
    const h = harness(), pending = CreativeResponseAdoptionRequestViewSchema.parse({ ...view(command(), "cancelled"), artifactCleanup: "pending", canCancel: true });
    h.state.lookup = pending; h.state.indexed = [pending];
    h.state.cancelResult = CreativeResponseAdoptionRequestViewSchema.parse({ ...pending, artifactCleanup: "complete", canCancel: false });
    const session = h.session(); await session.read();
    expect((await session.cancel()).request).toEqual(h.state.cancelResult);
    expect(h.posts).toEqual([{ path: "/api/creative-executions/" + ids.execution + "/response-adoptions/" + ids.adoption + "/cancel", body: { requestId } }]);
    await expect(session.cancel()).rejects.toThrow("不可取消"); expect(h.posts).toHaveLength(1); expect(h.generated()).toBe(0);
  });

  it("does not infer cleanup permission from cancelled pending status when the current server canCancel proof is false", async () => {
    const h = harness(), pending = CreativeResponseAdoptionRequestViewSchema.parse({ ...view(command(), "cancelled"), artifactCleanup: "pending", canCancel: false });
    h.state.lookup = pending; h.state.indexed = [pending]; const session = h.session(); await session.read();
    await expect(session.cancel()).rejects.toThrow("不可取消"); expect(h.posts).toHaveLength(0); expect(h.generated()).toBe(0);
  });

  it("requires exact read-only lookup after cleanup ACK loss before explicitly retrying the same cancellation", async () => {
    const h = harness(), pending = CreativeResponseAdoptionRequestViewSchema.parse({ ...view(command(), "cancelled"), artifactCleanup: "pending", canCancel: true });
    h.state.lookup = pending; h.state.indexed = [pending]; h.state.cancelResult = pending; h.state.postError = new TypeError("synthetic cleanup ACK loss");
    const session = h.session(); await session.read();
    await expect(session.cancel()).rejects.toThrow("synthetic cleanup ACK loss"); await expect(session.cancel()).rejects.toThrow("不可取消");
    expect(h.posts).toHaveLength(1); expect(session.snapshot().request).toBeUndefined();
    const reads = h.gets.length; await session.read(); expect(h.gets.slice(reads)).toEqual([
      "/api/creative-executions/" + ids.execution + "/response-adoption", "/api/creative-executions/" + ids.execution + "/response-adoptions/by-request/" + requestId]);
    expect(h.posts).toHaveLength(1); delete h.state.postError;
    h.state.cancelResult = CreativeResponseAdoptionRequestViewSchema.parse({ ...pending, artifactCleanup: "complete", canCancel: false });
    expect((await session.cancel()).request).toEqual(h.state.cancelResult); expect(h.generated()).toBe(0);
    expect(h.posts).toEqual(Array.from({ length: 2 }, () => ({ path: "/api/creative-executions/" + ids.execution + "/response-adoptions/" + ids.adoption + "/cancel", body: { requestId } })));
  });
});
