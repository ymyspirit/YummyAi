import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { StudioPaidImageInputSchema, type StudioPaidImageInput, type StudioPaidImageRequest } from "@yummyai/contracts/pod/studio-paid-image";
import { captureStudioContext, StudioApiError } from "./studio-api";
import { createStudioImageGenerationClient, studioImageInputText } from "./studio-image-generation-client";
import { abandonStudioImagePreparation, clearStudioImageGenerationIntents, createStudioImageGenerationIntent, STUDIO_IMAGE_GENERATION_INTENT_PREFIX, studioImageGenerationVault, studioImagePreparationMarkers, type StudioImageGenerationStorage } from "./studio-image-generation-intent";

const tenantId = "019a0000-0000-7000-8000-000000000001", userId = "019a0000-0000-7000-8000-000000000002";
const modelId = "019f0000-0000-7000-8000-000000000011", providerId = "019f0000-0000-7000-8000-000000000012";
const requestId = "ba9cb2c4-a7c2-4c06-a059-6d268336ad22", nextRequestId = "8121cc95-a94b-477a-b1c3-8bca6f793389";
const authority = erpSessionAuthority({ tenantId, userId, permissions: ["asset:write", "design:read", "design:write"], dataScope: "tenant", teamIds: [] });
const ownerHash = "a".repeat(64), now = Date.parse("2026-10-24T12:00:00.000Z");
const fields: Omit<StudioPaidImageInput, "requestId"> = { capability: "image", modelId, selectionRevision: "c".repeat(64), prompt: "Synthetic original prompt", referenceKeys: [], size: "1024x1024", quality: "auto", background: "transparent", seconds: 4 };
function memory() {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function original(input: StudioPaidImageInput, changes: Partial<StudioPaidImageRequest> = {}): StudioPaidImageRequest {
  const fixed = { version: 1 as const, inputFingerprint: createHash("sha256").update(studioImageInputText(input)).digest("hex"), modelId, providerConfigId: providerId, model: "synthetic-image", label: "图片测试模型", providerLabel: "合成渠道",
      selectionRevision: fields.selectionRevision, providerFingerprint: "e".repeat(64), contextAuthority: authority, unit: "image" as const, count: 1 as const, currency: "USD" as const, basis: "operator_estimate" as const,
      pricing: { estimatedUsd: "0.04000000", reservationUsd: "0.060000", reference: "Synthetic per-image estimate" }, size: input.size, quality: input.quality, background: input.background,
      references: [], createdAt: "2026-10-24T12:00:00.000Z", expiresAt: "2026-10-24T12:05:00.000Z" };
  return { version: 1, id: "019f0000-0000-7000-8000-000000000051", scope: "unassigned", requestId: input.requestId, originalInput: structuredClone(input), input,
    quote: { ...fixed, quoteHash: createHash("sha256").update(canonicalJson(fixed)).digest("hex") },
    status: "prepared", generationId: null, committedAt: null, createdAt: "2026-10-24T12:00:00.000Z", admission: { version: 1, enabled: false, code: "operator_paused" },
    execution: { phase: null, costUsd: null, budgetState: null, budgetAmountUsd: null, errorCode: null }, result: null, ...changes };
}
function repin(request: StudioPaidImageRequest) {
  request.quote.inputFingerprint = createHash("sha256").update(studioImageInputText(request.input)).digest("hex");
  const { quoteHash: previous, ...fixed } = request.quote;
  expect(previous).toMatch(/^[a-f0-9]{64}$/); request.quote.quoteHash = createHash("sha256").update(canonicalJson(fixed)).digest("hex");
  return request;
}
const quoteHash = original(StudioPaidImageInputSchema.parse({ ...fields, requestId })).quote.quoteHash;
function fixture(storageOverride?: StudioImageGenerationStorage, stamp = authority) {
  const storage = memory(); let active = true, server: StudioPaidImageRequest | undefined;
  const context = captureStudioContext({ authority: stamp, ownerScope: `${tenantId}:${userId}`, localDevelopment: false }, new AbortController().signal, () => active);
  const call = vi.fn<(input: Record<string, unknown>) => Promise<unknown>>().mockImplementation(async input => {
    if (input.operation === "paid.image.prepare") { server = original(StudioPaidImageInputSchema.parse(input.input)); return structuredClone(server); }
    if (input.operation === "paid.image.lookup") return server ? { status: "found", request: structuredClone(server) } : { status: "missing", scope: "unassigned", requestId: input.requestId };
    if (input.operation === "paid.image.requests") return { items: server ? [structuredClone(server)] : [], nextCursor: null };
    if (input.operation === "paid.image.cancel") {
      if (!server || server.status !== "prepared") throw new StudioApiError("原请求不允许取消", 409);
      server = { ...server, status: "cancelled" }; return structuredClone(server);
    }
    if (input.operation === "paid.image.abandon") {
      if (server?.generationId) throw new StudioApiError("原请求已提交 请只读核对", 409);
      if (server) server = { ...server, status: "cancelled" };
      return { version: 1, id: "019f0000-0000-7000-8000-000000000052", scope: "unassigned", requestId: input.requestId, status: "cancelled" };
    }
    throw new Error("Unexpected synthetic operation");
  });
  const client = createStudioImageGenerationClient({ scope: "unassigned", context, call });
  const id = vi.fn().mockReturnValueOnce(requestId).mockReturnValue(nextRequestId);
  const options = { client, ownerHash, storage: storageOverride ?? storage, current: () => { if (!active) throw new DOMException("CLEAR", "AbortError"); }, id, now: () => now };
  return { storage, call, client, id, options, intent: createStudioImageGenerationIntent(options), get server() { return server; }, set server(value: StudioPaidImageRequest | undefined) { server = value; },
    clear() { active = false; clearStudioImageGenerationIntents(options.storage); } };
}
const operations = (env: ReturnType<typeof fixture>) => env.call.mock.calls.map(([input]) => input.operation);

describe("single image original-key quotation and confirmation", () => {
  it("read-proves an identifiers-only marker before prepare and keeps estimate separate from unknown actual cost", async () => {
    const env = fixture(); env.call.mockImplementationOnce(async value => {
      const marker = studioImageGenerationVault(ownerHash, "unassigned", env.storage).read();
      expect(marker).toMatchObject({ requestId, quoteHash: null, commitHash: null });
      expect([...env.storage.values.values()].join()).not.toContain(fields.prompt);
      return original(StudioPaidImageInputSchema.parse(value.input));
    });
    const prepared = await env.intent.prepare(fields);
    expect(operations(env)).toEqual(["paid.image.prepare"]); expect(prepared.request?.quote.pricing.estimatedUsd).toBe("0.04000000");
    expect(prepared.request?.execution.costUsd).toBeNull(); expect(prepared.request?.execution.budgetState).toBeNull();
    expect(prepared.marker).toMatchObject({ requestId, quoteHash, commitHash: null }); expect(env.id).toHaveBeenCalledTimes(1);
  });
  it.each(["write", "readback"] as const)("does not prepare when local recovery %s fails", async failure => {
    const storage = memory(); let written = false;
    const guarded = { ...storage, setItem(key: string, value: string) { if (failure === "write") throw new Error("Synthetic quota"); storage.setItem(key, value); written = true; },
      getItem(key: string) { if (written) return null; return storage.getItem(key); } };
    const env = fixture(guarded); await expect(env.intent.prepare(fields)).rejects.toThrow("未继续提交"); expect(env.call).not.toHaveBeenCalled();
  });
  it("never commits a paused, expired, unacknowledged or authority-changed quote", async () => {
    const env = fixture(); await env.intent.prepare(fields);
    await expect(env.intent.commit(quoteHash)).rejects.toThrow("尚未启用");
    await expect(env.intent.commit("f".repeat(64))).rejects.toThrow("原报价");
    expect(operations(env)).toEqual(["paid.image.prepare"]);
    const enabled = { version: 1 as const, enabled: true, code: "ready" as const };
    const changedAuthority = erpSessionAuthority({ tenantId, userId, permissions: ["design:read"], dataScope: "tenant", teamIds: [] });
    const changed = fixture(undefined, changedAuthority), changedRequest = original(StudioPaidImageInputSchema.parse({ ...fields, requestId }), { admission: enabled }); changed.server = changedRequest; await changed.intent.read();
    await expect(changed.intent.commit(changedRequest.quote.quoteHash)).rejects.toThrow("权限已变化");
    const expired = fixture(), expiredRequest = original(StudioPaidImageInputSchema.parse({ ...fields, requestId }), { admission: enabled });
    expiredRequest.quote.expiresAt = "2026-10-24T11:59:59.000Z"; expiredRequest.quote.createdAt = "2026-10-24T11:55:00.000Z";
    expired.server = repin(expiredRequest); await expired.intent.read();
    await expect(expired.intent.commit(expiredRequest.quote.quoteHash)).rejects.toThrow("过期");
    for (const value of [env, changed, expired]) expect(operations(value).filter(operation => operation === "paid.image.commit")).toHaveLength(0);
  });
  it("recovers a lost prepare ACK with the same input and only original reads", async () => {
    const env = fixture(); env.call.mockImplementationOnce(async input => { env.server = original(StudioPaidImageInputSchema.parse(input.input)); throw new Error("Lost prepare ACK"); });
    await expect(env.intent.prepare(fields)).rejects.toThrow("Lost prepare ACK");
    await expect(env.intent.prepare({ ...fields, prompt: "new prompt" })).rejects.toThrow("已有原生图编号");
    const reloaded = createStudioImageGenerationIntent(env.options), result = await reloaded.read();
    expect(operations(env)).toEqual(["paid.image.prepare", "paid.image.lookup"]);
    expect(result.request?.input.prompt).toBe(fields.prompt); expect(result.marker?.requestId).toBe(requestId); expect(env.id).toHaveBeenCalledTimes(1);
  });
  it("persists exact commit identity before POST and never re-POSTs after lost ACK or reload", async () => {
    const env = fixture(); await env.intent.prepare(fields); const prepared = env.server;
    if (!prepared) throw new Error("Expected synthetic prepared request");
    env.server = { ...prepared, admission: { version: 1, enabled: true, code: "ready" } }; await env.intent.read();
    env.call.mockImplementationOnce(async input => {
      expect(input).toEqual({ operation: "paid.image.commit", requestId, quoteHash, confirmed: true });
      expect(studioImageGenerationVault(ownerHash, "unassigned", env.storage).read()?.commitHash).toMatch(/^[a-f0-9]{64}$/);
      env.server = { ...prepared, status: "queued", generationId: "019f0000-0000-7000-8000-000000000053", committedAt: "2026-10-24T12:00:01.000Z",
        execution: { phase: "queued", costUsd: null, budgetState: "reserved", budgetAmountUsd: "0.060000", errorCode: null } };
      throw new Error("Lost commit ACK");
    });
    await expect(env.intent.commit(quoteHash)).rejects.toThrow("Lost commit ACK");
    const reloaded = createStudioImageGenerationIntent(env.options), result = await reloaded.read();
    expect(result.request?.status).toBe("queued"); expect(result.request?.execution.costUsd).toBeNull();
    await expect(reloaded.commit(quoteHash)).rejects.toThrow("只读核对"); await expect(reloaded.beginAnother()).rejects.toThrow("不能换新请求");
    expect(operations(env).filter(value => value === "paid.image.commit")).toHaveLength(1); expect(env.id).toHaveBeenCalledTimes(1);
  });
  it("keeps missing unknown until explicit same-key abandon is acknowledged and never invents an unpaid proof", async () => {
    const env = fixture(); env.call.mockRejectedValueOnce(new StudioApiError("图片价格已变化", 409));
    await expect(env.intent.prepare(fields)).rejects.toThrow(); const missing = await env.intent.read(); expect(missing.missing).toBe(true);
    await expect(env.intent.beginAnother()).rejects.toThrow("不能换新请求");
    env.call.mockRejectedValueOnce(new Error("Lost abandon ACK")); await expect(env.intent.abandon()).rejects.toThrow("Lost abandon ACK");
    await expect(env.intent.beginAnother()).rejects.toThrow("不能换新请求");
    await env.intent.read(); expect(env.intent.snapshot().marker?.requestId).toBe(requestId);
    const proof = await env.intent.abandon(); expect(proof.abandoned).toMatchObject({ requestId, status: "cancelled" });
    await env.intent.beginAnother(); expect(env.storage.length).toBe(0); expect(env.id).toHaveBeenCalledTimes(1);
    await env.intent.prepare(fields); expect(env.intent.snapshot().marker?.requestId).toBe(nextRequestId);
    expect(operations(env).filter(value => value === "paid.image.abandon")).toHaveLength(2);
  });
  it("refuses a mismatched abandon proof and keeps the exact marker", async () => {
    const env = fixture(); env.call.mockRejectedValueOnce(new Error("Lost prepare ACK")); await expect(env.intent.prepare(fields)).rejects.toThrow();
    env.call.mockResolvedValueOnce({ version: 1, id: "019f0000-0000-7000-8000-000000000052", scope: "unassigned", requestId: nextRequestId, status: "cancelled" });
    await expect(env.intent.abandon()).rejects.toThrow(); await expect(env.intent.beginAnother()).rejects.toThrow("不能换新请求");
    expect(env.intent.snapshot().marker?.requestId).toBe(requestId);
  });
  it("requires a fresh cancellation proof and does not accept mutation of a public snapshot as terminal", async () => {
    const env = fixture(); const result = await env.intent.prepare(fields);
    if (!result.request) throw new Error("Expected prepared snapshot"); result.request.status = "cancelled";
    await expect(env.intent.beginAnother()).rejects.toThrow("不能换新请求");
    const cancelled = await env.intent.cancel(); expect(cancelled.request?.status).toBe("cancelled");
    expect(cancelled.marker?.requestId).toBe(requestId); await env.intent.beginAnother(); expect(env.storage.length).toBe(0);
    expect(operations(env)).toEqual(["paid.image.prepare", "paid.image.cancel"]);
  });
  it("restores an older active request through the server index after local markers are lost", async () => {
    const env = fixture(), active = original(StudioPaidImageInputSchema.parse({ ...fields, requestId }));
    const terminal = original(StudioPaidImageInputSchema.parse({ ...fields, requestId: nextRequestId }), { status: "cancelled", id: "019f0000-0000-7000-8000-000000000061" });
    env.call.mockResolvedValueOnce({ items: [terminal], nextCursor: terminal.id }).mockResolvedValueOnce({ items: [active], nextCursor: null }).mockResolvedValueOnce({ status: "found", request: active });
    const restored = await env.intent.read(); expect(restored.marker?.requestId).toBe(requestId); expect(restored.request?.status).toBe("prepared");
    expect(operations(env)).toEqual(["paid.image.requests", "paid.image.requests", "paid.image.lookup"]); expect(env.id).not.toHaveBeenCalled();
    expect(env.call.mock.calls[1]?.[0]).toEqual({ operation: "paid.image.requests", cursor: terminal.id, limit: 20 });
  });
  it("stops server-history recovery on a repeated or forward cursor without lookup or fresh identifiers", async () => {
    const env = fixture(), terminal = original(StudioPaidImageInputSchema.parse({ ...fields, requestId }), { status: "cancelled" });
    env.call.mockResolvedValueOnce({ items: [terminal], nextCursor: terminal.id }).mockResolvedValueOnce({ items: [terminal], nextCursor: terminal.id });
    await expect(env.intent.read()).rejects.toThrow(); expect(operations(env)).toEqual(["paid.image.requests", "paid.image.requests"]); expect(env.id).not.toHaveBeenCalled(); expect(env.storage.length).toBe(0);
  });
  it("rejects a changed original input or quote during lookup instead of overwriting the pinned request", async () => {
    const env = fixture(); await env.intent.prepare(fields); const server = env.server;
    if (!server) throw new Error("Expected synthetic original request");
    env.server = { ...server, originalInput: { ...server.originalInput, prompt: "Changed original prompt" } }; await expect(env.intent.read()).rejects.toThrow("固定编号");
    env.server = { ...server, quote: { ...server.quote, quoteHash: "f".repeat(64) } }; await expect(env.intent.read()).rejects.toThrow();
    expect(studioImageGenerationVault(ownerHash, "unassigned", env.storage).read()?.quoteHash).toBe(quoteHash);
    expect(operations(env).filter(value => value === "paid.image.prepare")).toHaveLength(1);
  });
  it("pins original 1:1 input while displaying normalized dimensions and appended project requirements", async () => {
    const env = fixture(); env.call.mockImplementationOnce(async value => {
      const submitted = StudioPaidImageInputSchema.parse(value.input), actual = { ...submitted, size: "1024x1024", prompt: `${submitted.prompt}\n\n项目固定需求：\nSynthetic fixed project requirement` };
      const result = original(actual); result.originalInput = submitted; env.server = result; return structuredClone(result);
    });
    const prepared = await env.intent.prepare({ ...fields, size: "1:1" });
    expect(prepared.request?.originalInput.size).toBe("1:1"); expect(prepared.request?.input.size).toBe("1024x1024");
    expect(prepared.request?.originalInput.prompt).toBe(fields.prompt); expect(prepared.request?.input.prompt).toContain("Synthetic fixed project requirement");
    expect(prepared.request?.quote.size).toBe("1024x1024");
    const reloaded = createStudioImageGenerationIntent(env.options), recovered = await reloaded.read();
    expect(recovered.marker).toEqual(prepared.marker); expect(recovered.request?.originalInput).toEqual(prepared.request?.originalInput);
    expect(operations(env)).toEqual(["paid.image.prepare", "paid.image.lookup"]);
    const server = env.server; if (!server) throw new Error("Expected synthetic normalized request");
    env.server = { ...server, input: { ...server.input, prompt: "Unpinned actual prompt" } }; await expect(reloaded.read()).rejects.toThrow();
  });
  it("does not let an unreadable history page lock an independently read-proven original preparation", async () => {
    const env = fixture(); await env.intent.prepare(fields); await env.intent.read();
    expect(operations(env)).toEqual(["paid.image.prepare", "paid.image.lookup"]);
    env.call.mockRejectedValueOnce(new StudioApiError("历史中的一份原资料当前无法核对", 409));
    await expect(env.intent.history()).rejects.toThrow(); expect(env.intent.snapshot().request?.status).toBe("prepared");
    await env.intent.cancel(); expect(env.intent.snapshot().request?.status).toBe("cancelled");
    expect(operations(env)).toEqual(["paid.image.prepare", "paid.image.lookup", "paid.image.requests", "paid.image.cancel"]);
  });
  it("discards a late prepared result after CLEAR without restoring its marker or new private state", async () => {
    const env = fixture(); let finish: (value: unknown) => void = () => { throw new Error("Expected held response"); };
    const held = new Promise<unknown>(resolve => { finish = resolve; }); env.call.mockReturnValueOnce(held);
    const pending = env.intent.prepare(fields), rejected = expect(pending).rejects.toBeInstanceOf(Error);
    // Let the actual hash and marker write finish without using a transport or timer mock.
    await vi.waitFor(() => expect(env.call).toHaveBeenCalledTimes(1));
    env.clear(); finish(original(StudioPaidImageInputSchema.parse({ ...fields, requestId }))); await rejected;
    expect(env.storage.length).toBe(0); expect(() => env.intent.snapshot()).toThrow(); expect(operations(env)).toEqual(["paid.image.prepare"]);
  });
  it("canonicalizes object fields without treating changed array order or prompt whitespace as the same input", () => {
    const input = StudioPaidImageInputSchema.parse({ ...fields, requestId, referenceKeys: ["first", "second"] });
    expect(studioImageInputText(input)).toBe(studioImageInputText({ ...input, prompt: input.prompt }));
    expect(studioImageInputText(input)).not.toBe(studioImageInputText({ ...input, referenceKeys: ["second", "first"] }));
    expect(studioImageInputText(input)).not.toBe(studioImageInputText({ ...input, prompt: "Synthetic  original prompt" }));
  });
});

describe("restricted-project identifiers-only preparation cleanup", () => {
  it("reads only the current principal markers and forgets only after exact server cancellation without any document read", async () => {
    const env = fixture(), prepared = await env.intent.prepare(fields), marker = prepared.marker;
    if (!marker) throw new Error("Expected original marker");
    const otherOwner = "f".repeat(64); studioImageGenerationVault(otherOwner, "unassigned", env.storage).save({ ...marker, requestId: nextRequestId });
    env.storage.setItem(`${STUDIO_IMAGE_GENERATION_INTENT_PREFIX}${ownerHash}:broken-scope`, "damaged");
    const reads = vi.spyOn(env.storage, "getItem"), indexed = studioImagePreparationMarkers(ownerHash, env.storage);
    expect(indexed.markers).toEqual([marker]); expect(indexed.invalid).toBe(1); expect(indexed.limited).toBe(false);
    expect(reads.mock.calls.every(([key]) => !key.includes(otherOwner))).toBe(true);
    const abandon = vi.fn().mockResolvedValueOnce({ version: 1, id: "019f0000-0000-7000-8000-000000000052", scope: "unassigned", requestId: nextRequestId, status: "cancelled" });
    await expect(abandonStudioImagePreparation({ ownerHash, marker, storage: env.storage, current: env.options.current, abandon })).rejects.toThrow("不一致");
    expect(studioImageGenerationVault(ownerHash, "unassigned", env.storage).read()).toEqual(marker);
    abandon.mockResolvedValueOnce({ version: 1, id: "019f0000-0000-7000-8000-000000000052", scope: "unassigned", requestId, status: "cancelled" });
    await abandonStudioImagePreparation({ ownerHash, marker, storage: env.storage, current: env.options.current, abandon });
    expect(studioImageGenerationVault(ownerHash, "unassigned", env.storage).read()).toBeUndefined();
    expect(studioImageGenerationVault(otherOwner, "unassigned", env.storage).read()?.requestId).toBe(nextRequestId);
    expect(abandon.mock.calls).toEqual([["unassigned", requestId], ["unassigned", requestId]]); expect(operations(env)).toEqual(["paid.image.prepare"]);
  });
  it("keeps unknown abandon ACK and rejects a late cancelled proof after CLEAR without recreating or clearing a new owner marker", async () => {
    const env = fixture(), prepared = await env.intent.prepare(fields), marker = prepared.marker;
    if (!marker) throw new Error("Expected original marker");
    const failed = vi.fn().mockRejectedValueOnce(new Error("Lost cleanup ACK"));
    await expect(abandonStudioImagePreparation({ ownerHash, marker, storage: env.storage, current: env.options.current, abandon: failed })).rejects.toThrow("Lost cleanup ACK");
    expect(studioImageGenerationVault(ownerHash, "unassigned", env.storage).read()).toEqual(marker);
    let finish: (value: unknown) => void = () => { throw new Error("Expected held acknowledgement"); };
    const held = new Promise<unknown>(resolve => { finish = resolve; });
    const pending = abandonStudioImagePreparation({ ownerHash, marker, storage: env.storage, current: env.options.current, abandon: () => held }), rejected = expect(pending).rejects.toBeInstanceOf(Error);
    env.clear(); const otherOwner = "f".repeat(64); studioImageGenerationVault(otherOwner, "unassigned", env.storage).save({ ...marker, requestId: nextRequestId });
    finish({ version: 1, id: "019f0000-0000-7000-8000-000000000052", scope: "unassigned", requestId, status: "cancelled" }); await rejected;
    expect(studioImageGenerationVault(otherOwner, "unassigned", env.storage).read()?.requestId).toBe(nextRequestId);
    expect(studioImageGenerationVault(ownerHash, "unassigned", env.storage).read()).toBeUndefined();
  });
  it("bounds marker body reads to 100 deterministic current-principal entries and reports the rest", () => {
    const storage = memory();
    for (let index = 1; index <= 101; index++) {
      const scope = `019f0000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
      studioImageGenerationVault(ownerHash, scope, storage).save({ version: 1, scope, requestId, inputHash: "b".repeat(64), quoteHash: null, commitHash: null });
    }
    const reads = vi.spyOn(storage, "getItem"), result = studioImagePreparationMarkers(ownerHash, storage);
    expect(result.markers).toHaveLength(100); expect(result.limited).toBe(true); expect(result.invalid).toBe(0); expect(reads).toHaveBeenCalledTimes(100);
    expect(result.markers.map(marker => marker.scope)).toEqual(result.markers.map(marker => marker.scope).sort());
  });
});
