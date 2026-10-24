import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Permission, type PermissionValue } from "@yummyai/authz";
import { createEntityId, MarketplacePublicationEventViewSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { PublicationPreviewReceiptSchema, PublicationPreviewRequestViewSchema,
  type CreatePublicationPreviewInput } from "@yummyai/contracts/marketplace/publication-preview";
import { connectDatabase } from "@yummyai/database";
import { requirePublicationAuthorityEnvironment } from "../../../../tools/testing/publication-authority-environment.mjs";
import { publicationAuthoritySceneFixture } from "./publication-authority-scene.test-fixture.js";
import { executionBounded } from "./publication-node-preview-provider.test-fixture.js";
import { executionCleanupDiagnostic } from "./publication-node-preview.test-fixture.js";

// The family guard must reject ordinary resources before connectDatabase is called.
const isolated = requirePublicationAuthorityEnvironment(process.env), database = connectDatabase(isolated.url),
  f = publicationAuthoritySceneFixture(database), proof: object[] = [], restores: Array<() => Promise<void>> = [];
const previewPath = "/v1/marketplace-publications/preview";
const readBits = [{ label: "ListingRead", bit: Permission.ListingRead }, { label: "StoreRead", bit: Permission.StoreRead }] as const;
type Scene = Awaited<ReturnType<typeof f.scene>>;
type Child = Awaited<ReturnType<typeof f.original.workNode>>;
type Submitted = Awaited<ReturnType<typeof submit>>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function personal(scene: Scene) {
  const response = await f.original.http("/v1/identity/session", undefined, scene.who);
  expect(response.status).toBe(200);
  const session = ErpSessionViewSchema.parse(response.body);
  expect(session.tenantId).toBe(scene.who.tenantId); expect(session.userId).toBe(scene.who.userId);
  return { session, authority: erpSessionAuthority(session) };
}

async function submit(scene: Scene) {
  const input = await f.original.previewInput(scene.source, scene.who);
  const response = await f.original.http(previewPath, input, scene.who);
  expect(response.status).toBe(201);
  const view = PublicationPreviewRequestViewSchema.parse(response.body);
  expect(view.intent).toMatchObject({ requestKey: input.requestKey, requestChecksum: input.requestChecksum });
  expect(view.request.listingVersionId).toBe(scene.source.versionId);
  expect(view.execution?.id).toBeTruthy();
  return { input, view };
}

function receiptPath(input: CreatePublicationPreviewInput) {
  return previewPath + "/receipt?" + new URLSearchParams({ requestKey: input.requestKey, requestChecksum: input.requestChecksum });
}

/** Safe diagnostic inspection never substitutes for the authenticated API denial below. */
async function originalState(scene: Scene, requestId: string) {
  const diagnostic = await f.diagnostics(scene, requestId), { request, intent, execution } = diagnostic;
  return {
    immutable: { requestId, requestSha256: request.sha256, intentId: intent.id, intentSha256: intent.sha256,
      requestKey: intent.requestKey, requestChecksum: intent.requestChecksum, targetSha256: intent.targetChecksum,
      requestAuthoritySha256: intent.authorityCeilingChecksum, executionAuthoritySha256: execution.authorityCeilingChecksum,
      executionInputSha256: execution.inputChecksum, executionRequestKey: execution.requestId,
      executionId: execution.id, executionRequestChecksum: execution.requestChecksum, accountId: execution.accountId, nodeId: execution.nodeId,
      certificateGeneration: execution.certificateGeneration, authorizationGeneration: execution.authorizationGeneration,
      bindingRevision: execution.bindingRevision, listingVersionId: request.listingVersionId, payloadChecksum: request.payloadChecksum },
    events: diagnostic.events,
    execution: { id: execution.id, state: execution.state, phase: execution.phase, errorCode: execution.errorCode,
      claimId: execution.claimId, snapshotId: execution.snapshotId, completionChecksum: execution.completionChecksum },
    steps: diagnostic.steps
      .map(row => ({ id: row.id, ordinal: row.ordinal, requestClass: row.requestClass, outcome: row.outcome,
        httpStatus: row.httpStatus, requestDigest: row.requestDigest, responseDigest: row.responseDigest, receiptChecksum: row.receiptChecksum })),
    snapshots: diagnostic.snapshots,
    diagnostic,
  };
}
type OriginalState = Awaited<ReturnType<typeof originalState>>;

function assertNoAdoption(before: OriginalState, after: OriginalState) {
  expect(after.immutable).toEqual(before.immutable);
  expect(after.events.slice(0, before.events.length)).toEqual(before.events);
  expect(after.events.filter(row => row.status === "validation_passed" || row.status === "validation_failed")).toEqual([]);
  expect(after.events.slice(before.events.length).every(row =>
    ["processing", "failed", "reconciliation_required"].includes(row.status) &&
    (row.status === "processing" || row.code === "store_node_authority_changed"))).toBe(true);
  expect(after.execution.snapshotId).toBeNull(); expect(after.snapshots).toEqual(before.snapshots);
  expect(after.execution.state).not.toBe("succeeded");
}

function physicalSince(index: number) {
  return f.original.provider.records.slice(index).filter(row => row.node).map(row => ({ ordinal: row.ordinal, kind: row.kind,
    method: row.method, status: row.status, responseFinished: row.responseFinished, credentialAccepted: row.credentialAccepted,
    ...(row.kind === "amazon_listing_validation_preview" ? { originalPreviewTarget: row.originalPreviewTarget, originalPreviewBody: row.originalPreviewBody } : {}) }));
}
function assertPhysical(index: number, expected: "none" | "lwa" | "both") {
  const records = physicalSince(index);
  expect(records.map(row => row.kind)).toEqual(expected === "none" ? [] : expected === "lwa" ? ["amazon_lwa"] : ["amazon_lwa", "amazon_listing_validation_preview"]);
  for (const row of records) expect(row).toMatchObject({ method: row.kind === "amazon_lwa" ? "POST" : "PUT", status: 200, responseFinished: true, credentialAccepted: true });
  if (expected === "both") expect(records[1]).toMatchObject({ originalPreviewTarget: true, originalPreviewBody: true });
  return records;
}

function assertOnlyReadRemoved(before: Awaited<ReturnType<typeof personal>>, after: Awaited<ReturnType<typeof personal>>, bit: PermissionValue) {
  expect(after.session.permissions.slice().sort()).toEqual(before.session.permissions.filter(value => value !== bit).sort());
  expect(after.session.permissionScopes?.[bit]).toBeUndefined();
  for (const permission of before.session.permissions.filter(value => value !== bit))
    expect(after.session.permissionScopes?.[permission]).toBe(before.session.permissionScopes?.[permission]);
  expect(after.session.permissions).toContain(Permission.ListingPublish);
  expect(after.session.permissionScopes?.[Permission.ListingPublish]).toBe("tenant");
  expect(after.authority).not.toBe(before.authority);
}

function headPaths(scene: Scene, submitted: Submitted, accountIds = scene.store.id.toLowerCase()) {
  return { listing: "/v1/listings/" + scene.source.listingId, request: previewPath + "/" + submitted.view.request.id,
    workspace: previewPath + "/workspace?" + new URLSearchParams({ listingId: scene.source.listingId,
      listingVersionId: scene.source.versionId, accountIds }) };
}
async function head(path: string, status: number, who = f.original.a) {
  const response = await f.head(path, who); expect(response.status).toBe(status); expect(response.bodyBytes).toBe(0);
  if (status === 200) expect(response.cacheControl).toBe("private, no-store");
}
async function apiDenied(scene: Scene, submitted: Submitted, status: 403 | 404, listingStatus: 200 | 403 | 404) {
  const counts = f.original.provider.counts();
  // Each of these is the actual OIDC/Nest reader. Diagnostics above do not supply its authority.
  for (const path of [previewPath + "/" + submitted.view.request.id, receiptPath(submitted.input),
    "/v1/marketplace-publications/" + submitted.view.request.id + "/events"])
    expect((await f.original.http(path, undefined, scene.who)).status).toBe(status);
  const paths = headPaths(scene, submitted);
  await head(paths.listing, listingStatus, scene.who); await head(paths.request, status, scene.who); await head(paths.workspace, status, scene.who);
  expect(f.original.provider.counts()).toEqual(counts);
}

async function entered(gate: ReturnType<typeof f.arm>, child: Child) {
  await executionBounded(Promise.race([gate.entered.promise, child.done.then(() => {
    throw new Error("publication_authority_cli_ended_before_original_provider_gate");
  })]), "publication_authority_original_provider_gate_deadline", 30_000);
}

async function settle(scene: Scene, submitted: Submitted, child: Child, phase: "before_lwa" | "after_lwa" | "after_put", bit: PermissionValue) {
  await expect.poll(async () => child.evidence.exited || (await originalState(scene, submitted.view.request.id)).execution.state === "authority_changed",
    { timeout: 30_000 }).toBe(true);
  const state = await originalState(scene, submitted.view.request.id);
  if (phase === "after_put" || phase === "before_lwa" && bit === Permission.ListingRead)
    expect(state.execution).toMatchObject({ state: "authority_changed", errorCode: "store_node_authority_changed" });
  if (phase === "before_lwa" && bit === Permission.StoreRead) {
    expect(child.evidence.exited).toBe(true); expect(child.evidence.stderrCode).toBe("store_node_authority_rejected");
    expect(state.execution).toMatchObject({ state: "waiting_node", claimId: null });
  }
  if (phase === "after_lwa") {
    expect(["claimed", "running", "authority_changed"]).toContain(state.execution.state);
    expect(state.steps.map(row => row.requestClass)).toEqual(["amazon_lwa"]);
  }
  const stoppedByAuthority = child.evidence.exited;
  if (stoppedByAuthority) {
    expect(child.evidence.exitCode).toBe(1);
    expect(["store_node_authority_changed", "store_node_authority_rejected"]).toContain(child.evidence.stderrCode);
  } else expect(state.execution.state).toBe("authority_changed");
  await child.close(); expect(child.evidence.exited).toBe(true); expect(child.evidence.forced).toBe(false); expect(child.evidence.leaked).toBe(false);
  return { state, stoppedByAuthority, cliCode: child.evidence.stderrCode, cliExitCode: child.evidence.exitCode };
}

async function recoverOnlyOriginalGets(scene: Scene, submitted: Submitted, before: OriginalState, restore: () => Promise<void>) {
  const physical = f.original.provider.counts(); await restore();
  const recovered = await f.original.http(receiptPath(submitted.input), undefined, scene.who); expect(recovered.status).toBe(200);
  const receipt = PublicationPreviewReceiptSchema.parse(recovered.body); expect(receipt.found).toBe(true);
  expect(receipt.request?.request.id).toBe(submitted.view.request.id);
  expect(receipt.request?.intent).toMatchObject({ requestKey: submitted.input.requestKey, requestChecksum: submitted.input.requestChecksum });
  const read = await f.original.http(previewPath + "/" + submitted.view.request.id, undefined, scene.who); expect(read.status).toBe(200);
  const view = PublicationPreviewRequestViewSchema.parse(read.body);
  expect(view.request.id).toBe(submitted.view.request.id); expect(view.request.listingVersionId).toBe(scene.source.versionId);
  expect(view.intent?.target).toMatchObject({ payloadChecksum: submitted.input.payloadChecksum,
    assetManifestChecksum: submitted.input.assetManifestChecksum, capabilitySnapshotId: submitted.input.capabilitySnapshotId });
  const events = await f.original.http("/v1/marketplace-publications/" + submitted.view.request.id + "/events", undefined, scene.who); expect(events.status).toBe(200);
  const history = z.array(MarketplacePublicationEventViewSchema).parse(events.body);
  expect(history.slice().sort((left, right) => left.sequence - right.sequence).map(row => ({ id: row.id, sequence: row.sequence, status: row.status })))
    .toEqual(before.events.map(row => ({ id: row.id, sequence: row.sequence, status: row.status })));
  expect(f.original.provider.counts()).toEqual(physical);
  const after = await originalState(scene, submitted.view.request.id); assertNoAdoption(before, after);
  expect(after.events).toEqual(before.events); expect(after.execution).toEqual(before.execution); expect(after.steps).toEqual(before.steps);
  return { recoveredRequestId: view.request.id, recoveryMethods: ["GET", "GET", "GET"], recoveryProviderDelta: 0, diagnostic: after.diagnostic };
}

beforeAll(() => f.initialize());
afterEach(async () => {
  const errors: unknown[] = [];
  try { await f.original.stopChildren(); } catch (error) { errors.push(error); }
  for (const restore of restores.splice(0).reverse()) try { await restore(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Publication authority case cleanup failed");
});
afterAll(async () => {
  const errors: unknown[] = [], cleanupDiagnostics: ReturnType<typeof executionCleanupDiagnostic> = [];
  for (const [phase, close] of [["fixture", () => f.close()], ["database", () => database.client.end()]] as const)
    try { await close(); } catch (error) { errors.push(error); cleanupDiagnostics.push(...executionCleanupDiagnostic(error, phase)); }
  await mkdir(isolated.lane, { recursive: true });
  await writeFile(resolve(isolated.lane, isolated.nonce + "-authority-proof.json"), JSON.stringify({ operation: "f3c8a2d6", cases: proof,
    cleanup: f.original.evidence, cleanupFailureCount: errors.length, cleanupDiagnostics, realCliAndMtls: true, physicalProviderIsSynthetic: true,
    independentReadBits: true, oldSuitesRerun: false }));
  if (errors.length) throw new AggregateError(errors, "Publication authority fixture cleanup failed");
});

describe("original Publication independent current read authority", () => {
  it.each(readBits)("after_put [$label] rejects the actual late validation when only this read bit is withdrawn", async ({ bit, label }) => {
    const scene = await f.scene(), submitted = await submit(scene), original = await originalState(scene, submitted.view.request.id),
      index = f.original.provider.records.length, old = await personal(scene), gate = f.arm("amazon_listing_validation_preview"), child = await f.original.workNode(scene.node.keys);
    try {
      await entered(gate, child); const atGate = await originalState(scene, submitted.view.request.id);
      const changed = await f.setPermissionScopes(scene.who, { [bit]: null }); restores.push(changed.restore);
      const current = await personal(scene); assertOnlyReadRemoved(old, current, bit); await apiDenied(scene, submitted, 403, bit === Permission.ListingRead ? 403 : 200);
      gate.release.release(); const done = await settle(scene, submitted, child, "after_put", bit);
      assertNoAdoption(original, done.state); assertNoAdoption(atGate, done.state); const physical = assertPhysical(index, "both");
      const recovery = await recoverOnlyOriginalGets(scene, submitted, done.state, changed.restore);
      expect((await personal(scene)).authority).toBe(old.authority);
      proof.push({ phase: "after_put", bit: label, oldAuthoritySha256: sha(old.authority), newAuthoritySha256: sha(current.authority),
        requestId: submitted.view.request.id, immutable: done.state.immutable, physical, stoppedByAuthority: done.stoppedByAuthority,
        cliCode: done.cliCode, cliExitCode: done.cliExitCode, recovery });
    } finally { gate.release.release(); await child.close(); }
  });

  it.each([
    { label: "ListingRead", bit: Permission.ListingRead, other: Permission.StoreRead, object: "listing" as const, otherObject: "store" as const, denied: 404 as const },
    { label: "StoreRead", bit: Permission.StoreRead, other: Permission.ListingRead, object: "store" as const, otherObject: "listing" as const, denied: 403 as const },
  ])("same_stamp_self [$label] rejects a late result after only the original object owner changes", async ({ bit, other, object, otherObject, label, denied }) => {
    const scene = await f.scene(), scopes = await f.setPermissionScopes(scene.who, { [bit]: "self", [other]: "tenant" }); restores.push(scopes.restore);
    // The other read's tenant grant must really permit a peer-owned object, without widening this self bit.
    const otherOwner = await f.moveOwner(scene, otherObject, f.original.peer); restores.push(otherOwner.restore);
    const before = await personal(scene); expect(before.session.permissions).toContain(Permission.ListingPublish);
    expect(before.session.permissionScopes?.[bit]).toBe("self"); expect(before.session.permissionScopes?.[other]).toBe("tenant");
    expect(before.session.permissionScopes?.[Permission.ListingPublish]).toBe("tenant");
    const submitted = await submit(scene), original = await originalState(scene, submitted.view.request.id), index = f.original.provider.records.length,
      gate = f.arm("amazon_listing_validation_preview"), child = await f.original.workNode(scene.node.keys);
    try {
      await entered(gate, child); const atGate = await originalState(scene, submitted.view.request.id);
      const moved = await f.moveOwner(scene, object, f.original.peer); restores.push(moved.restore);
      const current = await personal(scene); expect(current.authority).toBe(before.authority);
      expect(current.session.permissionScopes?.[bit]).toBe("self"); expect(current.session.permissionScopes?.[other]).toBe("tenant");
      await apiDenied(scene, submitted, denied, object === "listing" ? 404 : 200); gate.release.release();
      const done = await settle(scene, submitted, child, "after_put", bit);
      assertNoAdoption(original, done.state); assertNoAdoption(atGate, done.state); const physical = assertPhysical(index, "both");
      const recovery = await recoverOnlyOriginalGets(scene, submitted, done.state, moved.restore);
      expect((await personal(scene)).authority).toBe(before.authority);
      proof.push({ phase: "same_stamp_self", bit: label, object, otherReadScope: "tenant", authoritySha256: sha(before.authority),
        authorityUnchanged: true, requestId: submitted.view.request.id, immutable: done.state.immutable, physical,
        stoppedByAuthority: done.stoppedByAuthority, cliCode: done.cliCode, cliExitCode: done.cliExitCode, recovery });
    } finally { gate.release.release(); await child.close(); }
  });

  it.each(readBits)("before_lwa [$label] rejects before the first physical HTTP after only this read bit is withdrawn", async ({ bit, label }) => {
    const scene = await f.scene(), submitted = await submit(scene), original = await originalState(scene, submitted.view.request.id), old = await personal(scene),
      index = f.original.provider.records.length, changed = await f.setPermissionScopes(scene.who, { [bit]: null }); restores.push(changed.restore);
    const current = await personal(scene); assertOnlyReadRemoved(old, current, bit); await apiDenied(scene, submitted, 403, bit === Permission.ListingRead ? 403 : 200);
    const child = await f.original.workNode(scene.node.keys);
    try {
      const done = await settle(scene, submitted, child, "before_lwa", bit); assertNoAdoption(original, done.state);
      expect(done.state.steps).toEqual([]); const physical = assertPhysical(index, "none");
      const recovery = await recoverOnlyOriginalGets(scene, submitted, done.state, changed.restore);
      expect((await personal(scene)).authority).toBe(old.authority);
      proof.push({ phase: "before_lwa", bit: label, requestId: submitted.view.request.id, immutable: done.state.immutable, physical,
        rawExecutionState: done.state.execution.state, stoppedByAuthority: done.stoppedByAuthority, cliCode: done.cliCode, cliExitCode: done.cliExitCode, recovery });
    } finally { await child.close(); }
  });

  it.each(readBits)("after_lwa [$label] rejects the next physical PUT after only this read bit is withdrawn", async ({ bit, label }) => {
    const scene = await f.scene(), submitted = await submit(scene), original = await originalState(scene, submitted.view.request.id), old = await personal(scene),
      index = f.original.provider.records.length, gate = f.arm("amazon_lwa"), child = await f.original.workNode(scene.node.keys);
    try {
      await entered(gate, child); const atGate = await originalState(scene, submitted.view.request.id);
      const changed = await f.setPermissionScopes(scene.who, { [bit]: null }); restores.push(changed.restore);
      const current = await personal(scene); assertOnlyReadRemoved(old, current, bit); await apiDenied(scene, submitted, 403, bit === Permission.ListingRead ? 403 : 200);
      gate.release.release(); const done = await settle(scene, submitted, child, "after_lwa", bit);
      assertNoAdoption(original, done.state); assertNoAdoption(atGate, done.state); const physical = assertPhysical(index, "lwa");
      expect(done.state.steps.some(row => row.requestClass === "amazon_listing_validation_preview")).toBe(false);
      const recovery = await recoverOnlyOriginalGets(scene, submitted, done.state, changed.restore);
      expect((await personal(scene)).authority).toBe(old.authority);
      proof.push({ phase: "after_lwa", bit: label, requestId: submitted.view.request.id, immutable: done.state.immutable, physical,
        rawExecutionState: done.state.execution.state, stoppedByAuthority: done.stoppedByAuthority, cliCode: done.cliCode, cliExitCode: done.cliExitCode, recovery });
    } finally { gate.release.release(); await child.close(); }
  });

  it("head_current_read proves three bodyless private checks and rejects independent read, owner scope, foreign and invalid account queries without provider HTTP", async () => {
    const scene = await f.scene(), submitted = await submit(scene), original = await originalState(scene, submitted.view.request.id),
      counts = f.original.provider.counts(), paths = headPaths(scene, submitted);
    for (const path of [paths.listing, paths.request, paths.workspace, headPaths(scene, submitted, "").workspace]) await head(path, 200, scene.who);
    for (const { bit } of readBits) {
      const changed = await f.setPermissionScopes(scene.who, { [bit]: null }); restores.push(changed.restore);
      try {
        await head(paths.listing, bit === Permission.ListingRead ? 403 : 200, scene.who);
        await head(paths.workspace, 403, scene.who); await head(paths.request, 403, scene.who);
      } finally { await changed.restore(); }
    }
    const peerResponse = await f.original.http("/v1/identity/session", undefined, f.original.peer); expect(peerResponse.status).toBe(200);
    const peer = ErpSessionViewSchema.parse(peerResponse.body);
    expect(peer.tenantId).toBe(scene.who.tenantId); expect(peer.userId).not.toBe(scene.who.userId);
    expect(peer.permissionScopes?.[Permission.ListingRead]).toBe("tenant"); expect(peer.permissionScopes?.[Permission.StoreRead]).toBe("tenant");
    await head(paths.listing, 200, f.original.peer); await head(paths.workspace, 200, f.original.peer);
    await head(paths.request, 404, f.original.peer);
    expect((await f.original.http(paths.request, undefined, f.original.peer)).status).toBe(404);
    const peerScope = await f.setPermissionScopes(f.original.peer, { [Permission.ListingRead]: "self", [Permission.StoreRead]: "self" }); restores.push(peerScope.restore);
    for (const path of [paths.listing, paths.request, paths.workspace]) {
      await head(path, 404, f.original.peer); await head(path, 404, f.original.foreign);
    }
    await peerScope.restore();
    const different = [scene.store.id, createEntityId()].sort(), invalid = ["not-an-id", scene.store.id + "," + scene.store.id,
      scene.store.id.toUpperCase(), different.reverse().join(","), Array.from({ length: 121 }, () => createEntityId()).sort().join(",")];
    expect(scene.store.id.toUpperCase()).not.toBe(scene.store.id);
    for (const accountIds of invalid) await head(headPaths(scene, submitted, accountIds).workspace, 400, scene.who);
    await head(paths.workspace + "&accountIds=" + scene.store.id, 400, scene.who);
    expect(f.original.provider.counts()).toEqual(counts);
    const after = await originalState(scene, submitted.view.request.id);
    expect(after.diagnostic).toEqual(original.diagnostic);
    expect(after.execution).toMatchObject({ state: "waiting_node", claimId: null }); expect(after.steps).toEqual([]);
    proof.push({ phase: "head_current_read", requestId: submitted.view.request.id, positiveBodylessKinds: ["listing", "preview", "workspace"],
      positiveEmptyAccounts: true, independentMissingReadStatus: 403, selfAndForeignStatus: 404, invalidAccountQueriesStatus: 400,
      peerTenantListingAndWorkspaceStatus: 200, peerOriginalPreviewGetAndHeadStatus: 404,
      providerDelta: 0, originalStateUnchanged: true, diagnostic: after.diagnostic });
  });
});
