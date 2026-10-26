import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { CreativeOwnerResponseAdoptionRequestSchema, CreativeOwnerResponseAdoptionWorkspaceSchema } from "@yummyai/contracts/harness/creative-owner-response-adoption";
import { assetFiles, creativeOwnerResponseAdoptions, withTenant } from "@yummyai/database";
import { decodeCreativeOutputs, decodePodResponse, type CreativeResponse } from "@yummyai/pod-core";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireCreativeOwnerResponseAdoptionEnvironment } from "../../../../tools/testing/creative-owner-response-adoption-environment.mjs";
import { createCreativeOwnerResponseAdoptionFixture, ownerFixtureSha, type OwnerSeedKind } from "./creative-owner-response-adoption.test-fixture.js";

requireCreativeOwnerResponseAdoptionEnvironment();
type Fixture = Awaited<ReturnType<typeof createCreativeOwnerResponseAdoptionFixture>>;
const owners = ["creative_adaptation", "template_compile", "mockup_render", "studio_generation"] as const;
const outputs = (response: CreativeResponse) => response.kind === "pod"
  ? decodePodResponse(response.checkpoint).outputs : decodeCreativeOutputs(response);
describe("four real Creative owners adopt original archives without new execution or approval", () => {
  let f: Fixture;
  beforeEach(async () => { f = await createCreativeOwnerResponseAdoptionFixture(); });
  afterEach(async () => { if (f) await f.close(); });

  it.each(owners)("restores exact %s artifacts to its actual owner and preserves every original execution and fee", async kind => {
    const seed = await f.seed(kind), actor = await f.current(), command = await f.command(seed);
    const before = await f.original(seed), archive = await f.archive(seed);
    const workspace = CreativeOwnerResponseAdoptionWorkspaceSchema.parse(await f.service(seed).workspace(actor, seed.executionId));
    expect(workspace).toMatchObject({ kind, ownerId: seed.operation.ownerId, canAdopt: true, noNewModelCall: true, resultRequiresReview: true });
    const preview = await f.service(seed).preview(actor, seed.executionId, command.expectedBasis);
    expect(ownerFixtureSha(preview.bytes)).toBe(preview.artifactChecksum);
    expect(outputs(archive.response).map(output => ownerFixtureSha(output.bytes))).toContain(preview.artifactChecksum);
    expect(await sharp(preview.bytes).metadata()).toMatchObject({ format: "png" });
    expect(await f.original(seed)).toEqual(before);
    const result = CreativeOwnerResponseAdoptionRequestSchema.parse(await f.adopt(seed, command));
    expect(result.status).toBe("committed"); expect(result.receipt).toMatchObject({ kind, executionId: seed.executionId,
      requestId: command.requestId, ownerId: seed.operation.ownerId, rightsStatus: "unverified", approval: "review_required", noNewModelCall: true });
    const receipt = result.receipt!;
    expect(receipt.artifacts.length).toBe(kind === "template_compile" ? outputs(archive.response).length : 1);
    expect(receipt.artifacts.map(row => row.role).sort()).toEqual((kind === "template_compile"
      ? outputs(archive.response).map(output => output.role) : [kind === "creative_adaptation" ? "aspect_variant" : kind === "mockup_render" ? "mockup" : "image"]).sort());
    const originalHashes = outputs(archive.response).map(output => ownerFixtureSha(output.bytes));
    const facts = await f.facts(seed);
    expect(facts.role).toBe("yummyai_app"); expect(facts.adoptions).toHaveLength(1); expect(facts.assets).toHaveLength(receipt.artifacts.length);
    for (const file of facts.assets) {
      expect(file).toMatchObject({ rightsStatus: "unverified", version: 1, assetDomain: "authorized", ownerUserId: actor.userId });
      expect(file.rightsMetadata.approvedAt).toBeUndefined(); expect(originalHashes).toContain(file.checksumSha256);
      const bytes = await f.storage.readPrivate(actor, { ...file, assetDomain: "authorized" }, { requiredDomain: "authorized" });
      expect(ownerFixtureSha(bytes)).toBe(file.checksumSha256);
      expect(file.rightsMetadata.creativeResponseAdoption).toMatchObject({ adoptionId: result.id, executionId: seed.executionId, ownerKind: kind });
    }
    if (kind === "creative_adaptation") {
      expect(facts.versions[0]).toMatchObject({ status: "pending_review", reviewedAt: null, reviewedBy: null });
      expect(facts.links.filter(link => link.role === "aspect_variant")).toHaveLength(1);
    } else if (kind === "template_compile") {
      expect(facts.inspections[0]).toMatchObject({ status: "completed", confirmedAt: null, confirmedBy: null });
      for (const file of facts.assets) expect(file.rightsMetadata.source).toMatchObject({ kind: "licensed" });
    } else if (kind === "mockup_render") {
      expect(facts.outputs[0]).toMatchObject({ status: "succeeded", assetId: receipt.artifacts[0]!.assetId });
      expect(facts.items[0]).toMatchObject({ status: "awaiting_review", reviewedAt: null, reviewedBy: null });
      expect(facts.mockupParents[0]?.status).toBe("awaiting_review");
    } else {
      expect(facts.generations[0]).toMatchObject({ status: "completed", assetId: receipt.artifacts[0]!.assetId });
      expect(facts.entries).toHaveLength(1); expect(facts.entries[0]?.revision).toBe(1); expect(facts.revisions).toHaveLength(1);
      const originalRequest = await f.paid.lookup(actor, seed.scope!, facts.generations[0]!.requestId);
      expect(originalRequest.status).toBe("found");
      if (originalRequest.status !== "found") throw new Error("owner_fixture_original_paid_request_missing");
      expect(originalRequest.request.status).toBe("completed");
      expect(originalRequest.request.execution?.phase).toBe(before.executions[0]?.phase);
    }
    expect(await f.service(seed).lookup(actor, seed.executionId, command.requestId)).toEqual(result);
    expect(await f.adopt(seed, command)).toEqual(result);
    expect(await f.original(seed)).toEqual(before); expect(await f.archive(seed)).toEqual(archive);
  });

  it("stores an outpaint child's expanded original while its parent remains failed and requires local adaptation", async () => {
    const seed = await f.seed("adaptation_outpaint"), actor = await f.current(), command = await f.command(seed), before = await f.original(seed);
    const result = await f.adopt(seed, command), facts = await f.facts(seed);
    expect(result.receipt).toMatchObject({ kind: "creative_adaptation", disposition: "outpaint_artifact_ready", approval: "review_required" });
    expect(result.receipt?.artifacts.map(row => row.role)).toEqual(["expanded"]);
    expect(facts.links.filter(row => row.role === "aspect_variant")).toEqual([]);
    expect(facts.relations).toHaveLength(1); expect(facts.relations[0]?.relationType).toBe("result_to_derivative");
    expect(facts.versions[0]?.status).not.toBe("pending_review");
    expect(before.executions).toHaveLength(2); expect(before.executions.every(row => row.phase === "failed")).toBe(true);
    expect(await f.original(seed)).toEqual(before);
    expect((await f.service(seed).lookup(actor, seed.executionId, command.requestId)).receipt).toEqual(result.receipt);
  });

  it("serializes concurrent same-key adoption and recovers its committed receipt only by the original key", async () => {
    const seed = await f.seed("studio_generation"), actor = await f.current(), command = await f.command(seed), before = await f.original(seed);
    const replies = await Promise.all([f.adopt(seed, command), f.adopt(seed, command)]);
    expect(replies.every(row => ["processing", "committed"].includes(row.status))).toBe(true);
    const recovered = await f.service(seed).lookup(actor, seed.executionId, command.requestId);
    expect(recovered.status).toBe("committed"); expect(new Set(replies.map(row => row.id)).size).toBe(1);
    expect((await f.facts(seed)).adoptions).toHaveLength(1); expect((await f.facts(seed)).entries).toHaveLength(1);
    await expect(f.adopt(seed, { ...command, requestId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await expect(f.adopt(seed, { ...command, expectedBasis: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
    expect(await f.service(seed).lookup(actor, seed.executionId, command.requestId)).toEqual(recovered);
    expect(await f.original(seed)).toEqual(before);
  });

  it.each(owners)("rechecks current write authority after the real %s archive read without owner effects", async kind => {
    const seed = await f.seed(kind), command = await f.command(seed), before = await f.original(seed), held = f.hold("read");
    const pending = f.adopt(seed, command).then(value => ({ value }), error => ({ error }));
    try {
      await held.entered;
      await f.paid.grant(await f.current(), f.permissions.filter(value => value !== Permission.DesignReview), "tenant");
      held.release(); const result = await pending;
      expect("error" in result).toBe(true);
    } finally { held.clear(); await pending; await f.paid.grant(await f.current(), f.permissions, "tenant"); }
    const facts = await f.facts(seed);
    expect(facts.adoptions[0]?.status).toBe("prepared"); expect(facts.assets).toEqual([]);
    expect(await f.original(seed)).toEqual(before);
  });

  it("does not upgrade the original Studio permission ceiling when current permissions later expand", async () => {
    const seed = await f.seed("studio_generation", { withoutOriginalReview: true }), actor = await f.current(), before = await f.original(seed);
    expect(actor.permissions).toContain(Permission.DesignReview);
    const workspace = await f.service(seed).workspace(actor, seed.executionId);
    expect(workspace.canAdopt).toBe(false); expect(workspace.basis).toBeNull();
    await expect(f.adopt(seed, { requestId: randomUUID(), expectedBasis: "0".repeat(64), acknowledgeReviewRequired: true })).rejects.toThrow();
    expect((await f.facts(seed)).adoptions).toEqual([]); expect(await f.original(seed)).toEqual(before);
  });

  it.each(["creative_adaptation", "mockup_render"] as const)("blocks %s when its real parent is cancelled after the quote basis was read", async kind => {
    const seed = await f.seed(kind), command = await f.command(seed), before = await f.original(seed);
    if (kind === "creative_adaptation") await f.pod.cancelDesignBatch(await f.current(), seed.batchId!);
    else await f.mockups.cancelBatch(await f.current(), seed.parentId!);
    const workspace = await f.service(seed).workspace(await f.current(), seed.executionId);
    expect(workspace.canAdopt).toBe(false);
    await expect(f.adopt(seed, command)).rejects.toThrow(); expect((await f.facts(seed)).assets).toEqual([]);
    expect(await f.original(seed)).toEqual(before);
  });

  it("rejects a template whose current license expired or immutable source version changed", async () => {
    const seed = await f.seed("template_compile"), actor = await f.current(), command = await f.command(seed), before = await f.original(seed);
    const [source] = await withTenant(f.database.db, actor, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, seed.sourceAssetId!)));
    if (!source) throw new Error("owner_fixture_licensed_source_missing");
    try {
      await withTenant(f.database.db, actor, tx => tx.update(assetFiles).set({ rightsMetadata: { ...source.rightsMetadata,
        source: { ...(source.rightsMetadata.source as Record<string, unknown>), licenseExpiresAt: new Date(Date.now() - 60_000).toISOString() } } }).where(eq(assetFiles.id, source.id)));
      expect((await f.service(seed).workspace(actor, seed.executionId)).canAdopt).toBe(false);
      await expect(f.adopt(seed, command)).rejects.toThrow();
      await withTenant(f.database.db, actor, tx => tx.update(assetFiles).set({ rightsMetadata: source.rightsMetadata, version: 2 }).where(eq(assetFiles.id, source.id)));
      await expect(f.adopt(seed, command)).rejects.toThrow();
    } finally { await withTenant(f.database.db, actor, tx => tx.update(assetFiles).set({ rightsMetadata: source.rightsMetadata, version: source.version }).where(eq(assetFiles.id, source.id))); }
    expect((await f.facts(seed)).assets).toEqual([]); expect(await f.original(seed)).toEqual(before);
  });

  it("keeps personal original-key recovery private while an authorized tenant reviewer can verify the immutable business fact", async () => {
    const seed = await f.seed("template_compile"), actor = await f.current(), command = await f.command(seed), adopted = await f.adopt(seed, command);
    const peer = await f.paid.actor(actor.tenantId, "tenant"), peerContext = await f.paid.grant(peer.context, f.permissions, "tenant");
    await expect(f.service(seed).lookup(peerContext, seed.executionId, command.requestId)).rejects.toMatchObject({ status: 404 });
    expect((await f.service(seed).workspace(peerContext, seed.executionId)).requests).toEqual([]);
    const facts = await withTenant(f.database.db, peerContext, tx => tx.select().from(creativeOwnerResponseAdoptions).where(eq(creativeOwnerResponseAdoptions.id, adopted.id)));
    expect(facts).toHaveLength(1); expect(facts[0]?.receipt).toEqual(adopted.receipt);
    expect((await f.mockups.getInspection(peerContext, seed.inspectionId!)).status).toBe("completed");
    const foreign = await f.paid.actor();
    await expect(f.service(seed).lookup(foreign.context, seed.executionId, command.requestId)).rejects.toMatchObject({ status: 404 });
    expect(await withTenant(f.database.db, foreign.context, tx => tx.select().from(creativeOwnerResponseAdoptions))).toEqual([]);
  });
});

// Exporting this finite list lets later targeted cases share the actual owners,
// without claiming that UI tools or callback fixtures are owner coverage.
export const actualOwnerKinds: readonly OwnerSeedKind[] = owners;
