import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER, CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER, CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER, type CreativeResponseAdoptionCommand } from "@yummyai/contracts/harness/creative-response-adoption";
import { CreativeOwnerResponseAdoptionRequestSchema, CreativeOwnerResponseAdoptionWorkspaceSchema, type CreativeOwnerResponseAdoptionRequest, type CreativeOwnerResponseAdoptionWorkspace } from "@yummyai/contracts/harness/creative-owner-response-adoption";
import { createCreativeOwnerResponseAdoptionClient } from "./creative-owner-response-adoption-client";
import { clearCreativeOwnerResponseAdoptionIntents, createCreativeOwnerResponseAdoptionIntent, creativeOwnerResponseAdoptionVault, type CreativeOwnerResponseAdoptionStorage } from "./creative-owner-response-adoption-intent";

const ids = { execution: "019a0000-0000-7000-8000-000000000001", owner: "019a0000-0000-7000-8000-000000000002",
  adoption: "019a0000-0000-7000-8000-000000000003", asset: "019a0000-0000-7000-8000-000000000004",
  metadata: "019a0000-0000-7000-8000-000000000005", parent: "019a0000-0000-7000-8000-000000000006", other: "019a0000-0000-7000-8000-000000000007" };
const authority = erpSessionAuthority({ tenantId: ids.parent, userId: ids.other, permissions: ["design:read"], dataScope: "tenant", teamIds: [] });
const stamp = "2026-10-26T00:00:00.000Z", basis = "a".repeat(64), identity = "b".repeat(64), responseChecksum = "c".repeat(64);
const requestId = "00000000-0000-4000-8000-000000000001";
const command: CreativeResponseAdoptionCommand = { requestId, expectedBasis: basis, acknowledgeReviewRequired: true };
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const artifactChecksum = createHash("sha256").update(png).digest("hex");
type Kind = CreativeOwnerResponseAdoptionWorkspace["kind"];
const disposition = { creative_adaptation: "aspect_ready", template_compile: "template_inspected", mockup_render: "mockup_ready", studio_generation: "studio_image_ready" } as const;
function view(kind: Kind, status: CreativeOwnerResponseAdoptionRequest["status"] = "committed", input = command): CreativeOwnerResponseAdoptionRequest {
  return CreativeOwnerResponseAdoptionRequestSchema.parse({ id: ids.adoption, executionId: ids.execution, requestId: input.requestId, command: input,
    status, attempts: 1, leaseActive: false, canRetry: status === "prepared", canCancel: status === "prepared", errorCode: null,
    artifactCleanup: status === "committed" ? "registered" : status === "cancelled" ? "complete" : "not_required", createdAt: stamp, updatedAt: stamp,
    receipt: status === "committed" ? { version: "creative-owner-response-adoption-v1", id: ids.adoption, executionId: ids.execution, requestId: input.requestId,
      basis: input.expectedBasis, kind, stepKey: "generate", ownerId: ids.owner, parentId: ids.parent, ownerStatus: "ready", ownerReceiptChecksum: "d".repeat(64),
      originalPhase: "failed", inputFingerprint: "e".repeat(64), responseChecksum, encryptedChecksum: "f".repeat(64), originalCostUsd: null,
      artifacts: [{ role: "preview", assetId: ids.asset, version: 1, checksumSha256: artifactChecksum, mediaType: "image/png", byteSize: png.byteLength, width: 1, height: 1 },
        ...(kind === "template_compile" ? [{ role: "template_json", assetId: ids.metadata, version: 1, checksumSha256: "1".repeat(64), mediaType: "application/json", byteSize: 2, width: null, height: null }] : [])],
      disposition: disposition[kind], rightsStatus: "unverified", approval: "review_required", noNewModelCall: true, committedAt: stamp } : null });
}
function workspace(kind: Kind, requests: CreativeOwnerResponseAdoptionRequest[] = []): CreativeOwnerResponseAdoptionWorkspace {
  return CreativeOwnerResponseAdoptionWorkspaceSchema.parse({ version: "creative-owner-response-adoption-v1", executionId: ids.execution, kind,
    stepKey: "generate", ownerId: ids.owner, parentId: ids.parent, parentExecutionId: null, ownerStatus: "failed", identityStamp: identity, originalPhase: "failed", basis,
    canInspectOriginal: true, canAdopt: !requests.length, blockers: [], source: { inputFingerprint: "e".repeat(64), responseChecksum,
      encryptedChecksum: "f".repeat(64), archiveState: "registered_unverified", archiveExpiresAt: "2026-11-01T00:00:00.000Z", providerRequestId: "synthetic-original",
      receivedAt: stamp, originalCostUsd: null, providerInvoiceVerified: false }, requests, noNewModelCall: true, resultRequiresReview: true });
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-yummyai-context-authority": authority } });
const image = () => new Response(png, { headers: { "content-type": "image/png", "x-yummyai-context-authority": authority,
  [CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER]: basis, [CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER]: responseChecksum, [CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER]: artifactChecksum } });
class MemoryStorage implements CreativeOwnerResponseAdoptionStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
function client(kind: Kind, transport: typeof fetch, current: () => void = () => {}) {
  return createCreativeOwnerResponseAdoptionClient({ executionId: ids.execution, authority, signal: new AbortController().signal, current, fetch: transport,
    expected: { kind, stepKey: "generate", parentExecutionId: null, inputFingerprint: "e".repeat(64) } });
}

describe("original owner response boundaries", () => {
  it.each([
    ["creative_adaptation", "kind"], ["template_compile", "owner"], ["mockup_render", "phase"], ["studio_generation", "response"],
  ] as const)("keeps %s real artifact pins and rejects another %s provenance", async (kind, mismatch) => {
    const valid = view(kind); let reply = structuredClone(valid), originalWorkspace = workspace(kind);
    const transport = vi.fn<typeof fetch>(async input => String(input).endsWith("/owner-response-adoption") ? json(originalWorkspace) : json(reply));
    const api = client(kind, transport); const read = await api.workspace();
    expect(read.parentId).toBe(ids.parent); expect(read.parentExecutionId).toBeNull();
    if (kind === "creative_adaptation") { originalWorkspace = { ...originalWorkspace, parentExecutionId: ids.other };
      await expect(api.workspace()).rejects.toMatchObject({ status: 502 }); originalWorkspace = workspace(kind); }
    expect(await api.lookup(command)).toEqual(valid);
    expect(valid.receipt?.approval).toBe("review_required");
    if (kind === "template_compile") expect(valid.receipt?.artifacts.map(artifact => [artifact.role, artifact.mediaType])).toEqual([["preview", "image/png"], ["template_json", "application/json"]]);
    reply = structuredClone(valid);
    const receipt = reply.receipt!;
    if (mismatch === "kind") receipt.kind = "studio_generation";
    if (mismatch === "owner") receipt.ownerId = ids.other;
    if (mismatch === "phase") receipt.originalPhase = "uncertain";
    if (mismatch === "response") receipt.responseChecksum = "2".repeat(64);
    await expect(api.lookup(command)).rejects.toMatchObject({ status: 502 });
    expect(transport.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("rejects a late body after actor CLEAR without restoring the cleared original marker", async () => {
    let active = true, release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), resumed = new Promise<void>(resolve => { release = resolve; });
    const storage = new MemoryStorage(); creativeOwnerResponseAdoptionVault(identity, storage).save(ids.execution, command);
    const current = () => { if (!active) throw new Error("synthetic_actor_cleared"); };
    const cancel = vi.fn(); let delivered = false;
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      if (delivered) { controller.close(); return; } entered(); await resumed; delivered = true;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(workspace("studio_generation"))));
    }, cancel }, { highWaterMark: 0 });
    const transport = vi.fn<typeof fetch>(async () => new Response(body, { headers: { "content-type": "application/json", "x-yummyai-context-authority": authority } }));
    const helper = createCreativeOwnerResponseAdoptionIntent({ executionId: ids.execution, client: client("studio_generation", transport, current), storage, current, id: () => requestId });
    const pending = helper.read(); await started; active = false; clearCreativeOwnerResponseAdoptionIntents(storage); release();
    await expect(pending).rejects.toThrow("synthetic_actor_cleared");
    expect(storage.length).toBe(0); expect(cancel).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce();
  });

  it("cancels only with the complete persisted original command", async () => {
    const original = view("template_compile", "prepared");
    const transport = vi.fn<typeof fetch>(async (_input, init) => json(init?.method === "POST" ? view("template_compile", "cancelled") : workspace("template_compile", [original])));
    const api = client("template_compile", transport); await api.workspace();
    expect((await api.cancel(original)).status).toBe("cancelled");
    const [url, init] = transport.mock.calls[1]!;
    expect(String(url)).toBe(`/api/creative-executions/${ids.execution}/owner-response-adoptions/${ids.adoption}/cancel`);
    expect(JSON.parse(String(init?.body))).toEqual(command);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("keeps an unknown adoption POST on its original key through missing lookup and later committed recovery", async () => {
    const storage = new MemoryStorage(), id = vi.fn(() => requestId); let committed: CreativeOwnerResponseAdoptionRequest | null = null, missing = true;
    const posts: CreativeResponseAdoptionCommand[] = [];
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (init?.method === "POST") { const body = JSON.parse(String(init.body)) as CreativeResponseAdoptionCommand; posts.push(body); committed = view("studio_generation", "committed", body); throw new Error("synthetic_lost_adoption_ack"); }
      if (path.includes("/preview?")) return image();
      if (path.includes("/by-request/")) return missing ? json({}, 404) : json(committed);
      return json(workspace("studio_generation"));
    });
    const helper = createCreativeOwnerResponseAdoptionIntent({ executionId: ids.execution, client: client("studio_generation", transport), storage, current: () => {}, id });
    await helper.read(); const inspected = await helper.inspect(); helper.previewLoaded(inspected.basis, inspected.artifactChecksum);
    await expect(helper.adopt(basis)).rejects.toThrow("synthetic_lost_adoption_ack");
    expect((await helper.read()).lookupMissing).toBe(true); expect(helper.snapshot().intent?.command).toEqual(command);
    missing = false; const recovered = await helper.read();
    expect(recovered.request?.status).toBe("committed"); expect(recovered.request?.receipt?.originalCostUsd).toBeNull();
    expect(posts).toEqual([command]); expect(id).toHaveBeenCalledOnce();
    expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
