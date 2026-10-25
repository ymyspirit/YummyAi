import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { VisualDeliverySnapshotSchema, type ProductVisualProject } from "@yummyai/contracts/catalog/product-visuals";
import { PrepareProductVisualImageSchema, ProductVisualImageOriginalSchema } from "@yummyai/contracts/catalog/product-visual-generation";
import { StudioPaidImageInputSchema, StudioPaidImageRequestSchema, type StudioPaidImageRequest } from "@yummyai/contracts/pod/studio-paid-image";
import { captureStudioContext } from "../creative-studio/studio-api";
import { createStudioImageGenerationIntent, type StudioImageGenerationStorage } from "../creative-studio/studio-image-generation-intent";
import { createProductVisualGenerationClient } from "./product-visual-generation-client";

const ids = { tenant: "019a0000-0000-7000-8000-000000000001", user: "019a0000-0000-7000-8000-000000000002",
  plan: "019a0000-0000-7000-8000-000000000003", group: "019a0000-0000-7000-8000-000000000004", artwork: "019a0000-0000-7000-8000-000000000005",
  scene: "019a0000-0000-7000-8000-000000000006", detail: "019a0000-0000-7000-8000-000000000007", customization: "019a0000-0000-7000-8000-000000000008",
  model: "019a0000-0000-7000-8000-000000000009", provider: "019a0000-0000-7000-8000-000000000010", sample: "019a0000-0000-7000-8000-000000000011",
  output: "019a0000-0000-7000-8000-000000000012", generation: "019a0000-0000-7000-8000-000000000013", entry: "019a0000-0000-7000-8000-000000000014",
  prepared: "019a0000-0000-7000-8000-000000000015" };
const requestId = "00000000-0000-4000-8000-000000000001", stamp = "2026-10-26T00:00:00.000Z";
const authority = erpSessionAuthority({ tenantId: ids.tenant, userId: ids.user, permissions: ["design:read", "design:write", "asset:read", "asset:write"], dataScope: "tenant", teamIds: [] });
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const snapshot = VisualDeliverySnapshotSchema.parse({ version: 1, productType: "shaped_pillow", groupId: ids.group, slotKey: "artwork", requestFingerprint: "a".repeat(64),
  salesPlanId: ids.plan, salesPlanRevision: 2, sourceFingerprint: "b".repeat(64), sampleAssetId: ids.sample, sampleAttestation: "Synthetic owned sample evidence",
  modelId: ids.model, providerConfigId: ids.provider, providerModel: "synthetic-image", providerFingerprint: "c".repeat(64), size: "1024x1024", callCeilingUsd: 0.06, totalBudgetUsd: 1 });
function project(): ProductVisualProject {
  return { id: ids.group, name: "Synthetic four-slot delivery", snapshot: structuredClone(snapshot), stale: false, adoptedRevision: null, tasks: [], budget: { occupiedUsd: 0, remainingUsd: 1, actualUsd: null },
    slots: [{ slotKey: "artwork", projectId: ids.artwork }, { slotKey: "scene", projectId: ids.scene }, { slotKey: "detail", projectId: ids.detail }, { slotKey: "customization", projectId: ids.customization }] };
}
const originalInput = () => StudioPaidImageInputSchema.parse({ requestId, capability: "image", modelId: ids.model, selectionRevision: "d".repeat(64), visualSlotKey: "artwork",
  prompt: "Synthetic explicit adjustment", referenceKeys: [], size: "1024x1024", quality: "high", background: "transparent", seconds: 4 });
function paid(status: "prepared" | "queued" | "completed" = "prepared", pin = structuredClone(snapshot)): StudioPaidImageRequest {
  const original = originalInput(), input = { ...original, prompt: `${original.prompt}\nSynthetic fixed project instructions` };
  const fixed = { version: 1, inputFingerprint: hash(canonicalJson({ input, visualDelivery: pin })), modelId: ids.model, providerConfigId: ids.provider,
    model: "synthetic-image", label: "Synthetic image", providerLabel: "Synthetic channel", selectionRevision: original.selectionRevision, providerFingerprint: pin.providerFingerprint,
    contextAuthority: authority, unit: "image", count: 1, currency: "USD", basis: "operator_estimate", pricing: { estimatedUsd: "0.04000000", reservationUsd: "0.060000", reference: "Synthetic per-image estimate" },
    size: original.size, quality: original.quality, background: original.background, references: [{ assetId: pin.sampleAssetId, version: 1, checksum: "e".repeat(64) }],
    visualDelivery: pin, createdAt: stamp, expiresAt: "2026-10-26T00:05:00.000Z" };
  return StudioPaidImageRequestSchema.parse({ version: 1, id: ids.prepared, scope: ids.artwork, requestId, originalInput: original, input,
    quote: { ...fixed, quoteHash: hash(canonicalJson(fixed)) }, status, generationId: status === "prepared" ? null : ids.generation, createdAt: stamp, committedAt: status === "prepared" ? null : stamp,
    admission: { version: 1, enabled: true, code: "ready" }, execution: { phase: status === "prepared" ? null : status === "queued" ? "pending" : "completed", costUsd: null,
      budgetState: status === "prepared" ? null : "reserved", budgetAmountUsd: status === "prepared" ? null : "0.060000", errorCode: null },
    result: status === "completed" ? { assetId: ids.output, namespace: "image_files", key: `image:${ids.generation}`, mediaType: "image/png", checksumSha256: hash(png), byteSize: png.byteLength, rightsStatus: "unverified" } : null });
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "x-yummyai-context-authority": authority } });
function setup(transport: typeof fetch, value = project()) {
  const context = captureStudioContext({ authority, ownerScope: `${ids.tenant}:${ids.user}`, localDevelopment: false }, new AbortController().signal, () => true);
  return createProductVisualGenerationClient({ planId: ids.plan, project: value, slotKey: "artwork", context, fetch: transport });
}
function original() {
  return ProductVisualImageOriginalSchema.parse({ scope: ids.artwork, slotKey: "artwork", requestId, generationId: ids.generation, key: `image:${ids.generation}`,
    inspection: { source: { entryId: ids.entry, revision: 1, namespace: "image_files", assetId: ids.output, assetVersion: 1, checksumSha256: hash(png), mediaType: "image/png", byteSize: png.byteLength, sourceKind: "ai_generated" },
      technical: { status: "verified", kind: "image", encodedWidth: 1, encodedHeight: 1, displayWidth: 1, displayHeight: 1, orientation: 1, validation: "full_static_decode" } } });
}
class MemoryStorage implements StudioImageGenerationStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("controlled visual producer transport boundaries", () => {
  it("rejects changed whole visual facts even when both input and quote hashes are correctly recomputed", async () => {
    const wrong = paid("prepared", { ...snapshot, sampleAttestation: "Different sample evidence" });
    const transport = vi.fn<typeof fetch>(async () => json({ status: "found", request: wrong }));
    await expect(setup(transport).lookup(requestId)).rejects.toMatchObject({ status: 502 });
    expect(transport).toHaveBeenCalledOnce();
  });
  it("rejects another slot scope and ambiguous scope mappings without falling back to a project or model", async () => {
    const wrong = paid(); wrong.scope = ids.scene;
    const transport = vi.fn<typeof fetch>(async () => json({ status: "found", request: wrong }));
    await expect(setup(transport).lookup(requestId)).rejects.toMatchObject({ status: 502 });
    expect(String(transport.mock.calls[0]?.[0])).toContain(`/images/by-request/${requestId}?slotKey=artwork`);
    const ambiguous = project(); ambiguous.slots.push({ slotKey: "artwork", projectId: ids.scene });
    expect(() => setup(transport, ambiguous)).toThrow("项目映射"); expect(transport).toHaveBeenCalledOnce();
  });
  it("rejects forged quote and input hashes despite valid HTTP and schema-shaped records", async () => {
    const wrongQuote = paid(); wrongQuote.quote.quoteHash = "0".repeat(64);
    const wrongInput = paid(); wrongInput.quote.inputFingerprint = "0".repeat(64);
    const { quoteHash: ignored, ...fixed } = wrongInput.quote;
    expect(ignored).toMatch(/^[a-f0-9]{64}$/); wrongInput.quote.quoteHash = hash(canonicalJson(fixed));
    for (const request of [wrongQuote, wrongInput]) {
      const transport = vi.fn<typeof fetch>(async () => json({ status: "found", request }));
      await expect(setup(transport).lookup(requestId)).rejects.toMatchObject({ status: 502 }); expect(transport).toHaveBeenCalledOnce();
    }
  });
  it("keeps failed technical inspection explicit and rejects a substituted original asset or checksum", async () => {
    const request = paid("completed"), unavailable = original(); unavailable.inspection.technical = { status: "failed", code: "invalid_media" };
    let reply = unavailable;
    const transport = vi.fn<typeof fetch>(async () => json(reply)); const api = setup(transport);
    expect((await api.prepareOriginal(request)).inspection.technical).toEqual({ status: "failed", code: "invalid_media" });
    reply = original(); reply.inspection.source.assetId = ids.sample;
    await expect(api.prepareOriginal(request)).rejects.toMatchObject({ status: 502 });
    reply = original(); reply.inspection.source.checksumSha256 = "0".repeat(64);
    await expect(api.prepareOriginal(request)).rejects.toMatchObject({ status: 502 });
    expect(transport.mock.calls.every(([url, init]) => String(url).endsWith("/prepare-original") && JSON.stringify(JSON.parse(String(init?.body))) === JSON.stringify({ slotKey: "artwork", requestId }))).toBe(true);
  });
  it("retains the same paid intent after lost commit ACK and only reads until that original queued request is resolved", async () => {
    let server: StudioPaidImageRequest | undefined; const posts: string[] = [];
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/images/prepare")) { const body = PrepareProductVisualImageSchema.parse(JSON.parse(String(init?.body))); expect(body).toEqual({ requestId, slotKey: "artwork", selectionRevision: "d".repeat(64), prompt: "Synthetic explicit adjustment" }); posts.push(url); server = paid(); return json(server); }
      if (url.endsWith("/images/commit")) { posts.push(url); expect(JSON.parse(String(init?.body))).toEqual({ slotKey: "artwork", requestId, quoteHash: paid().quote.quoteHash, confirmed: true }); server = paid("queued"); throw new Error("synthetic_lost_commit_ack"); }
      if (url.includes("/images/by-request/")) return json(server ? { status: "found", request: server } : { status: "missing", scope: ids.artwork, requestId });
      return json({ items: server ? [server] : [], nextCursor: null });
    });
    const api = setup(transport), storage = new MemoryStorage(), id = vi.fn(() => requestId);
    const intent = createStudioImageGenerationIntent({ client: api, storage, ownerHash: hash(JSON.stringify([ids.tenant, ids.user])), current: () => {}, id, now: () => Date.parse(stamp) });
    await intent.read(); const { requestId: originalId, ...fields } = originalInput(); expect(originalId).toBe(requestId);
    const prepared = await intent.prepare(fields); const quoteHash = prepared.request!.quote.quoteHash;
    await expect(intent.commit(quoteHash)).rejects.toThrow("synthetic_lost_commit_ack");
    const recovered = await intent.read(); expect(recovered.request?.status).toBe("queued"); expect(recovered.marker?.requestId).toBe(requestId);
    expect(recovered.request?.execution).toMatchObject({ costUsd: null, budgetState: "reserved", budgetAmountUsd: "0.060000" });
    await expect(intent.commit(quoteHash)).rejects.toThrow(); await expect(intent.beginAnother()).rejects.toThrow();
    expect(posts.map(url => url.slice(url.lastIndexOf("/")))).toEqual(["/prepare", "/commit"]); expect(id).toHaveBeenCalledOnce();
    expect(transport.mock.calls.some(([url]) => /\/(generate|collect)$/.test(String(url)))).toBe(false);
  });
});
