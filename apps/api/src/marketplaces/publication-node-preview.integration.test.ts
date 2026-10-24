import { createHash, createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { PublicationPreviewRequestViewSchema, PublicationPreviewReceiptSchema, PublicationPreviewWorkspaceSchema, PublicationPreviewTargetSchema,
  publicationPreviewPayloadText, publicationPreviewRequestText, STORE_NODE_PUBLICATION_OPERATION,
  type CreatePublicationPreviewInput } from "@yummyai/contracts/marketplace/publication-preview";
import { STORE_NODE_EXECUTION_PROTOCOL, StoreNodeExecutionClaimSchema, StoreNodeExecutionHistorySchema } from "@yummyai/contracts/marketplace/store-node-execution";
import { connectDatabase, marketplacePublicationIntents, marketplacePublicationRequests, marketplacePublicationEvents,
  memberships, marketplaceStoreNodeBindings, withTenant } from "@yummyai/database";
import { openStoreNodeJournal } from "../../../store-api-node/src/identity.js";
import { requirePublicationNodePreviewEnvironment } from "../../../../tools/testing/publication-node-preview-environment.mjs";
import { executionBounded } from "./publication-node-preview-provider.test-fixture.js";
import { publicationNodePreviewFixture, lane, nodeExecutionPermissions, nodeExecutionSha, safeCode,
  executionCleanupDiagnostic, type PreviewSource } from "./publication-node-preview.test-fixture.js";

const isolated = requirePublicationNodePreviewEnvironment(process.env, "current"), database = connectDatabase(isolated.url),
  f = publicationNodePreviewFixture(database), proof: object[] = [];
const previewPath = "/v1/marketplace-publications/preview";
const lookup = (input: CreatePublicationPreviewInput) => ({ requestKey: input.requestKey, requestChecksum: input.requestChecksum });
const targetOf = (input: CreatePublicationPreviewInput) => PublicationPreviewTargetSchema.parse(Object.fromEntries(
  Object.entries(input).filter(([key]) => key !== "requestKey" && key !== "requestChecksum")));
const receiptPath = (input: CreatePublicationPreviewInput) => previewPath + "/receipt?" + new URLSearchParams(lookup(input));
async function scene(who = f.a) {
  const original = await f.bootstrapStore(who), source = await f.seedListing(original.store.id, who);
  return { ...original, source, who };
}
async function submit(source: PreviewSource, who = f.a, original?: CreatePublicationPreviewInput) {
  const input = original ?? await f.previewInput(source, who), response = await f.http(previewPath, input, who);
  expect(response.status, JSON.stringify({ status: response.status, code: safeCode(response.body) })).toBe(201);
  return { input, view: PublicationPreviewRequestViewSchema.parse(response.body) };
}
async function receipt(input: CreatePublicationPreviewInput, who = f.a) {
  const response = await f.http(receiptPath(input), undefined, who);
  expect(response.status, JSON.stringify({ status: response.status, code: safeCode(response.body) })).toBe(200);
  return PublicationPreviewReceiptSchema.parse(response.body);
}
async function finish(s: Awaited<ReturnType<typeof scene>>, options: Parameters<typeof f.workNode>[1] = {}) {
  const created = await submit(s.source, s.who), child = await f.workNode(s.node.keys, options);
  return { ...created, child, result: await f.waitPreview(created.view.request.id, child, s.who) };
}
async function journal(s: Awaited<ReturnType<typeof scene>>) {
  const bytes = await readFile(resolve(s.node.keys.directory, "execution.pe"));
  try { return z.object({ completed: z.boolean(), lease: z.object({ id: z.uuidv7(), requestId: z.uuidv7(), requestChecksum: z.string(), operation: z.string() }).passthrough(),
    rows: z.array(z.object({ ordinal: z.number(), requestClass: z.string(), state: z.string(), stepAcknowledged: z.boolean() }).passthrough()),
    completion: z.object({ payloadChecksum: z.string() }).passthrough().nullable() }).passthrough().parse(await openStoreNodeJournal(bytes, s.node.keys.passphrase,
      nodeExecutionSha(createPublicKey(s.node.keys.publicKeyPem).export({ type: "spki", format: "der" }))));
  } finally { bytes.fill(0); }
}
async function zeroPlatformWrites() {
  return withTenant(database.db, f.a.ceiling, async tx => (await tx.execute<{ paid: number; submitted: number; syncs: number }>(sql`select
    (select count(*)::int from ai_budget_ledger) paid,(select count(*)::int from marketplace_publication_requests where action<>'amazon_validation_preview') submitted,
    (select count(*)::int from marketplace_listing_sync_requests) syncs`))[0]!);
}
beforeAll(() => f.initialize());
afterEach(async () => {
  f.provider.controls.fault = "none"; f.provider.controls.faultKind = null; f.provider.controls.validationStatus = "ACCEPTED";
  await f.stopChildren();
  for (const who of [f.a, f.peer, f.foreign]) {
    await withTenant(database.db, who.ceiling, tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, who.membershipId)));
    await f.rights(who);
  }
});
afterAll(async () => {
  const errors: unknown[] = [], cleanupDiagnostics: ReturnType<typeof executionCleanupDiagnostic> = [];
  for (const [phase, close] of [["fixture", () => f.close()], ["database", () => database.client.end()]] as const)
    try { await close(); } catch (error) { errors.push(error); cleanupDiagnostics.push(...executionCleanupDiagnostic(error, phase)); }
  await writeFile(resolve(lane, isolated.nonce + "-current-proof.json"), JSON.stringify({ operation: "a6f4c2d9", cases: proof,
    cleanup: f.evidence, cleanupFailureCount: errors.length, cleanupDiagnostics, syntheticHistoricalAssetMetadata: true, platformPublication: false }));
  if (errors.length) throw new AggregateError(errors, "Publication node preview cleanup failed");
});

describe("original Publication owner through real CLI and mTLS validation preview", () => {
  it("pins one concurrent original preview and records exactly LWA plus VALIDATION_PREVIEW with original events and zero paid or publishing writes", async () => {
    const s = await scene(), before = f.provider.counts(), untouched = await zeroPlatformWrites(), input = await f.previewInput(s.source);
    const session = await f.http("/v1/identity/session"); expect(session.status).toBe(200);
    expect(ErpSessionViewSchema.parse(session.body)).toMatchObject({ userId: f.a.userId, tenantId: f.a.tenantId });
    const responses = await Promise.all([f.http(previewPath, input), f.http(previewPath, input)]);
    for (const response of responses) expect(response.status).toBe(201);
    const views = responses.map(response => PublicationPreviewRequestViewSchema.parse(response.body));
    expect(views[0]!.request.id).toBe(views[1]!.request.id);
    const saved = await f.previewRows(), intent = saved.intents.find(value => value.requestKey === input.requestKey)!;
    expect(saved.intents.filter(value => value.requestKey === input.requestKey)).toHaveLength(1);
    expect(intent).toMatchObject({ requestId: views[0]!.request.id, membershipId: f.a.membershipId, createdBy: f.a.userId,
      route: "node_preview", requestChecksum: input.requestChecksum, nodeExecutionId: views[0]!.execution!.id });
    expect(saved.executions.filter(value => value.id === intent.nodeExecutionId)).toHaveLength(1);
    const original = saved.requests.find(value => value.id === intent.requestId)!;
    expect(original.payloadChecksum).toBe(nodeExecutionSha(publicationPreviewPayloadText({ platform: "amazon", marketplaceId: "ATVPDKIKX0DER",
      locale: "en-US", productType: "HOME", sku: s.source.sku, attributes: s.source.attributes })));
    expect(input.assetManifestChecksum).toBe(nodeExecutionSha(publicationPreviewPayloadText(original.assetManifest)));
    const prepared = await f.publications.prepareForBatch(await f.current(), { accountId: s.store.id, listingId: s.source.listingId,
      listingVersionId: s.source.versionId, marketplaceId: "ATVPDKIKX0DER", variantSkuId: s.source.variantSkuId });
    const supplemental = prepared.assets.filter(value => value.assetId === s.source.supplementalAssetId);
    expect(supplemental).toHaveLength(1); expect(supplemental[0]!.publicationRole).toBe("supplemental");
    expect(Object.hasOwn(supplemental[0]!, "rank")).toBe(false);
    expect(original.assetManifest.find(value => value.assetId === s.source.supplementalAssetId)).toEqual(supplemental[0]);
    expect(publicationPreviewPayloadText(prepared.assets)).toBe(publicationPreviewPayloadText(original.assetManifest));
    expect(nodeExecutionSha(publicationPreviewPayloadText(prepared.assets))).toBe(input.assetManifestChecksum);
    const child = await f.workNode(s.node.keys), completed = await f.waitPreview(original.id, child);
    const diagnosticCode = (raw: unknown) => typeof raw === "string" && /^(?:[A-Z][A-Z0-9_]{0,100}|(?:publication|store_node|marketplace)_[a-z0-9_]{1,100})$/.test(raw) ? raw : null;
    const local = await journal(s).then(value => ({ completed: value.completed, rows: value.rows.map(row => ({ ordinal: row.ordinal,
      requestClass: ["amazon_lwa", "amazon_listing_validation_preview"].includes(row.requestClass) ? row.requestClass : "other",
      state: ["prepared", "submitted", "received", "unknown"].includes(row.state) ? row.state : "other", ack: row.stepAcknowledged })) }),
    () => ({ error: "original_journal_diagnostic_unavailable" }));
    const terminal = { original: { status: completed.request.current.status, code: diagnosticCode(completed.request.current.code) },
      execution: { state: completed.execution?.state ?? null, errorCode: diagnosticCode(completed.execution?.errorCode), phase: completed.execution?.phase ?? null },
      providerCountsBefore: before, providerCountsAfter: f.provider.counts(), providerRequests: f.provider.records.filter(value => value.node)
        .map(value => ({ ordinal: value.ordinal, requestClass: value.kind, method: value.method, status: value.status,
          originalPreviewTarget: value.originalPreviewTarget ?? null, originalPreviewBody: value.originalPreviewBody ?? null, credentialAccepted: value.credentialAccepted })), journal: local };
    proof.push({ case: "original_preview_terminal_diagnostic", ...terminal });
    expect(completed.request.current.status, JSON.stringify(terminal)).toBe("validation_passed"); expect(completed.execution?.state).toBe("succeeded");
    expect(completed.request.current.externalState).toBe("ACCEPTED"); expect(completed.access.canContinue).toBe(false);
    const after = f.provider.counts(); expect((after.amazon_lwa ?? 0) - (before.amazon_lwa ?? 0)).toBe(1);
    expect((after.amazon_listing_validation_preview ?? 0) - (before.amazon_listing_validation_preview ?? 0)).toBe(1);
    expect(f.provider.records.filter(value => value.node && value.kind === "amazon_listing_validation_preview").at(-1))
      .toMatchObject({ method: "PUT", status: 200, originalPreviewTarget: true, originalPreviewBody: true, credentialAccepted: true, responseFinished: true });
    const final = await f.previewRows(), steps = final.steps.filter(value => value.executionId === completed.execution!.id).sort((a, b) => a.ordinal - b.ordinal);
    expect(steps.map(value => [value.ordinal, value.requestClass, value.outcome, value.httpStatus])).toEqual([[1, "amazon_lwa", "received", 200], [2, "amazon_listing_validation_preview", "received", 200]]);
    const eventResponse = await f.http(`/v1/marketplace-publications/${original.id}/events`); expect(eventResponse.status).toBe(200);
    expect(z.array(z.object({ status: z.string() })).parse(eventResponse.body).map(value => value.status)).toEqual(["queued", "validation_passed"]);
    const history = await f.http(`/v1/marketplace-accounts/${s.store.id}/node-executions/history`); expect(history.status).toBe(200);
    expect(StoreNodeExecutionHistorySchema.parse(history.body).items.map(value => value.id)).toEqual([s.capabilityExecutionId]);
    expect((await f.accountRows(s.store.id)).snapshots).toHaveLength(1); expect(await zeroPlatformWrites()).toEqual(untouched);
    proof.push({ case: "original_two_http", requestId: original.id, executionId: completed.execution!.id, pins: lookup(input),
      stepClasses: steps.map(value => value.requestClass), lwaDelta: 1, previewDelta: 1, capOnlyHistory: true, noPlatformSubmission: true });
  });

  it("rejects changed immutable targets and enforces current member, actor, object range and tenant boundaries before any node HTTP", async () => {
    const s = await scene(), created = await submit(s.source), counts = f.provider.counts();
    const changed = { ...created.input, bindingRevision: created.input.bindingRevision + 1 };
    changed.requestChecksum = nodeExecutionSha(publicationPreviewRequestText(targetOf(changed)));
    expect((await f.http(previewPath, changed)).status).toBe(409);
    expect((await f.http(previewPath, { ...created.input, token: "SYNTHETIC-FORBIDDEN" })).status).toBe(400);
    expect((await f.http(previewPath + "/" + created.view.request.id, undefined, f.foreign)).status).toBe(404);
    expect((await f.http(previewPath + "/" + created.view.request.id, undefined, f.peer)).status).toBe(404);
    expect((await receipt(created.input, f.peer)).found).toBe(false);
    await f.rights(f.peer, nodeExecutionPermissions, "self");
    expect((await f.http(f.workspacePath({ listingId: s.source.listingId, listingVersionId: s.source.versionId, variantSkuId: s.source.variantSkuId }), undefined, f.peer)).status).toBe(404);
    await f.rights(f.a, nodeExecutionPermissions.filter(value => value !== Permission.ListingPublish));
    expect((await f.http(previewPath, { ...created.input, requestKey: createEntityId() })).status).toBe(403);
    expect((await receipt(created.input)).request?.request.id).toBe(created.view.request.id);
    await withTenant(database.db, f.a.ceiling, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, f.a.membershipId)));
    expect((await f.http(receiptPath(created.input))).status).toBe(403);
    expect(f.provider.counts()).toEqual(counts);
    proof.push({ case: "strict_current_boundaries", requestId: created.view.request.id, targetConflict: 409, actorHidden: 404, foreignHidden: 404, selfRangeHidden: 404, memberDenied: 403 });
  });

  it("recovers a genuinely unread original201 by GET receipt alone after the approved primary changes", async () => {
    const s = await scene(), input = await f.previewInput(s.source), counts = f.provider.counts(), before = await f.previewRows();
    const response = await fetch(f.origin + previewPath, { method: "POST", headers: { authorization: "Bearer " + await f.token(), "content-type": "application/json" },
      body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(15_000) });
    expect(response.status).toBe(201); await response.body?.cancel();
    const restored = await receipt(input); expect(restored.found).toBe(true); expect(restored.request?.intent).toMatchObject(lookup(input));
    const versions = await f.listings.getWorkspace(await f.current(), s.source.listingId);
    const next = await f.listings.saveVersion(await f.current(), s.source.listingId, { ...versions.version.content, title: s.source.title + " changed primary" }, "human", s.source.versionId);
    await f.listings.approveVersion(await f.current(), s.source.listingId, next.id);
    const recovered = await receipt(input); expect(recovered.request?.request.id).toBe(restored.request?.request.id);
    expect(recovered.request?.request.listingVersionId).toBe(s.source.versionId); expect(recovered.request?.intent?.target.payloadChecksum).toBe(input.payloadChecksum);
    const after = await f.previewRows(); expect(after.requests.length - before.requests.length).toBe(1); expect(after.intents.length - before.intents.length).toBe(1);
    expect(after.steps.length).toBe(before.steps.length); expect(f.provider.counts()).toEqual(counts);
    proof.push({ case: "unread201_original_get_only", requestId: recovered.request!.request.id, originalVersion: s.source.versionId, currentVersion: next.id,
      originalChecksum: input.requestChecksum, businessPosts: 1, recoveryPosts: 0, providerDelta: 0 });
  });

  it("requires explicit supported preview operation and never exposes a preview job through the original cap-only reader", async () => {
    const s = await scene(), submitted = await submit(s.source), node = (await f.rows(s.node.nodeId)).node!;
    const before = f.provider.counts(), raw = { protocol: STORE_NODE_EXECUTION_PROTOCOL, nodeId: node.id, certificateGeneration: node.certificateGeneration,
      sessionId: node.sessionId!, supportedAuthorizationModes: ["amazon_private"] };
    const response = await f.tls("/v1/store-nodes/runtime/executions/claim", raw, s.node.socket); expect(response.status).toBe(200);
    expect(StoreNodeExecutionClaimSchema.parse(response.body)).toMatchObject({ state: "empty", lease: null });
    expect((await f.http(`/v1/marketplace-accounts/${s.store.id}/node-executions/${submitted.view.execution!.id}`)).status).toBe(404);
    expect(f.provider.counts()).toEqual(before);
    const child = await f.workNode(s.node.keys), done = await f.waitPreview(submitted.view.request.id, child);
    expect(done.execution?.state).toBe("succeeded");
    proof.push({ case: "explicit_operation_dispatch", requestId: submitted.view.request.id, executionId: done.execution!.id, legacyClaim: "empty", capReader: 404 });
  });

  it("replays cached original completion after a lost mTLS ACK without resending either physical HTTP request", async () => {
    const s = await scene(), before = f.provider.counts(), done = await finish(s, { loss: "complete" });
    expect(done.result.execution?.state).toBe("succeeded");
    await expect.poll(async () => { try { return JSON.parse(await readFile(done.child.lossMarker, "utf8")) as unknown; } catch { return null; } }, { timeout: 15_000 })
      .toEqual({ rpc: "complete", status: 200, explicitSyntheticLoss: true });
    await done.child.close(); const original = await receipt(done.input), counts = f.provider.counts(), restarted = await f.workNode(s.node.keys);
    await expect.poll(async () => (await journal(s)).completed, { timeout: 15_000 }).toBe(true);
    expect((await journal(s)).lease).toMatchObject({ id: done.view.execution!.id, requestId: done.input.requestKey, requestChecksum: done.input.requestChecksum, operation: STORE_NODE_PUBLICATION_OPERATION });
    expect((await receipt(done.input)).request).toEqual(original.request);
    expect(f.provider.counts()).toEqual(counts); expect((counts.amazon_lwa ?? 0) - (before.amazon_lwa ?? 0)).toBe(1);
    expect((counts.amazon_listing_validation_preview ?? 0) - (before.amazon_listing_validation_preview ?? 0)).toBe(1);
    await restarted.close(); expect(restarted.evidence.leaked).toBe(false);
    proof.push({ case: "cached_completion_only", requestId: done.view.request.id, executionId: done.view.execution!.id, originalCompletionChecksum: (await journal(s)).completion!.payloadChecksum,
      restartHttpDelta: 0, explicitMtlSTransportLoss: true });
  });

  it("rejects a genuinely late validation after original member withdrawal and a revoked node generation without adopting old output", async () => {
    for (const withdrawal of ["member", "certificate"] as const) {
      const s = await scene(), submitted = await submit(s.source), held = f.provider.arm("amazon_listing_validation_preview"), child = await f.workNode(s.node.keys);
      try {
        await executionBounded(Promise.race([held.entered.promise, child.done.then(() => { throw new Error("publication_preview_cli_ended_before_gate"); })]), "publication_preview_provider_gate_deadline", 30_000);
        if (withdrawal === "member") await f.rights(f.a, nodeExecutionPermissions.filter(value => value !== Permission.ListingPublish));
        else { const workspace = await f.service.workspace(await f.current(), s.store.id);
          await f.service.revoke(await f.current(), s.store.id, s.node.nodeId, { expectedAuthorizationGeneration: workspace.authorizationGeneration,
            expectedBindingRevision: workspace.binding.revision, expectedCertificateGeneration: submitted.input.certificateGeneration }); }
        held.release.release();
        if (withdrawal === "member") {
          const result = await f.waitPreview(submitted.view.request.id, child); expect(result.execution?.state).toBe("authority_changed");
          expect(result.request.current.status).toBe("reconciliation_required");
        } else {
          await executionBounded(child.done, "publication_preview_revoked_cli_exit_deadline", 20_000);
          expect(["store_node_authority_changed", "store_node_authority_rejected"]).toContain(child.evidence.stderrCode);
        }
        const rows = await f.previewRows(), events = rows.events.filter(value => value.requestId === submitted.view.request.id);
        expect(events.some(value => value.status === "validation_passed" || value.status === "validation_failed")).toBe(false);
        expect(rows.requests.find(value => value.id === submitted.view.request.id)?.payloadChecksum).toBe(submitted.input.payloadChecksum);
        expect(rows.executions.find(value => value.id === submitted.view.execution!.id)?.snapshotId).toBeNull();
        expect((await f.accountRows(s.store.id)).snapshots).toHaveLength(1);
        proof.push({ case: "late_old_validation_rejected", withdrawal, requestId: submitted.view.request.id,
          executionId: submitted.view.execution!.id, adoptedValidationEvents: 0, physicalPreviewAccepted: true });
      } finally { held.release.release(); await child.close(); await f.rights(f.a); }
    }
  });

  it("keeps an unknown physical PUT unknown across a real process restart and never buys or submits a second request", async () => {
    const s = await scene(), before = f.provider.counts(); f.provider.controls.fault = "lose"; f.provider.controls.faultKind = "amazon_listing_validation_preview";
    const done = await finish(s); expect(done.result.execution?.state).toBe("unknown_outcome"); expect(done.result.request.current.status).toBe("reconciliation_required");
    await expect.poll(async () => (await journal(s)).completed, { timeout: 15_000 }).toBe(true); await done.child.close();
    const original = await receipt(done.input), rows = await f.previewRows(), counts = f.provider.counts();
    expect(rows.steps.filter(value => value.executionId === done.view.execution!.id).map(value => value.outcome)).toEqual(["received", "unknown"]);
    f.provider.controls.fault = "none"; const restarted = await f.workNode(s.node.keys);
    await expect.poll(() => restarted.evidence.states.some(value => value.state === "waiting" || value.state === "execution_finished"), { timeout: 15_000 }).toBe(true);
    expect((await receipt(done.input)).request).toEqual(original.request); expect(f.provider.counts()).toEqual(counts);
    expect((counts.amazon_listing_validation_preview ?? 0) - (before.amazon_listing_validation_preview ?? 0)).toBe(1);
    const local = await journal(s); expect(local.completed).toBe(true); expect(local.lease.requestId).toBe(done.input.requestKey);
    expect(local.rows.map(value => [value.requestClass, value.state])).toEqual([["amazon_lwa", "received"], ["amazon_listing_validation_preview", "unknown"]]);
    proof.push({ case: "unknown_no_resubmit", requestId: done.view.request.id, executionId: done.view.execution!.id, providerPutDelta: 1, restartPutDelta: 0, journalCompleted: true });
  });

  it("keeps cancellation, current source pins, immutable RLS history and provider failures separate from marketplace submission", async () => {
    const s = await scene(), created = await submit(s.source), counts = f.provider.counts();
    const cancelled = await f.http(previewPath + "/" + created.view.request.id + "/cancel", { reason: "Synthetic operator cancels before node claim" });
    expect(cancelled.status).toBe(201); const cancelledView = PublicationPreviewRequestViewSchema.parse(cancelled.body);
    expect(cancelledView.request.current.status).toBe("cancelled"); expect(cancelledView.execution?.state).toBe("cancelled"); expect(f.provider.counts()).toEqual(counts);
    const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await f.publications.create(await f.current(), { accountId: s.store.id, listingId: s.source.listingId,
      listingVersionId: s.source.versionId, marketplaceId: "ATVPDKIKX0DER", variantSkuId: s.source.variantSkuId, scheduledFor });
    expect(scheduled.current.status).toBe("scheduled"); expect(scheduled.scheduledFor).toBe(scheduledFor);
    const futureChild = await f.workNode(s.node.keys);
    await expect.poll(() => futureChild.evidence.states.some(value => value.state === "waiting"), { timeout: 15_000 }).toBe(true);
    const future = PublicationPreviewRequestViewSchema.parse(await f.publications.getPreview(await f.current(), scheduled.id));
    expect(future.execution?.state).toBe("waiting_node"); expect(future.request.current.status).toBe("scheduled");
    expect(f.provider.counts()).toEqual(counts); await futureChild.close();
    const stopped = await f.publications.cancelPreview(await f.current(), scheduled.id, { reason: "Synthetic future task cleanup before due time" });
    expect(stopped.request.current.status).toBe("cancelled"); expect(stopped.execution?.state).toBe("cancelled");
    const binding = await f.service.workspace(await f.current(), s.store.id);
    await f.service.revoke(await f.current(), s.store.id, s.node.nodeId, { expectedAuthorizationGeneration: binding.authorizationGeneration,
      expectedBindingRevision: binding.binding.revision, expectedCertificateGeneration: created.input.certificateGeneration });
    const unbound = PublicationPreviewWorkspaceSchema.parse((await f.http(f.workspacePath({ listingId: s.source.listingId,
      listingVersionId: s.source.versionId, variantSkuId: s.source.variantSkuId }))).body);
    expect(unbound.sources.find(value => value.accountId === s.store.id)).toMatchObject({ reason: "not_bound", canPrepare: false, target: null });
    const offline = await scene(), owned = await f.rows(offline.node.nodeId), offlineCounts = f.provider.counts();
    expect(owned.binding).toMatchObject({ accountId: offline.store.id, nodeId: offline.node.nodeId, state: "active" });
    const expired = await withTenant(database.db, f.a.ceiling, tx => tx.update(marketplaceStoreNodeBindings)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(and(eq(marketplaceStoreNodeBindings.id, owned.binding!.id),
        eq(marketplaceStoreNodeBindings.accountId, offline.store.id), eq(marketplaceStoreNodeBindings.nodeId, offline.node.nodeId),
        eq(marketplaceStoreNodeBindings.revision, owned.binding!.revision))).returning({ id: marketplaceStoreNodeBindings.id }));
    expect(expired).toEqual([{ id: owned.binding!.id }]);
    const offlineWorkspace = PublicationPreviewWorkspaceSchema.parse((await f.http(f.workspacePath({ listingId: offline.source.listingId,
      listingVersionId: offline.source.versionId, variantSkuId: offline.source.variantSkuId }))).body);
    expect(offlineWorkspace.sources.find(value => value.accountId === offline.store.id)).toMatchObject({ reason: "node_offline", canPrepare: false, target: null });
    expect(f.provider.counts()).toEqual(offlineCounts);
    await expect(withTenant(database.db, f.a.ceiling, tx => tx.update(marketplacePublicationIntents).set({ requestChecksum: "f".repeat(64) }).where(eq(marketplacePublicationIntents.requestId, created.view.request.id)))).rejects.toThrow();
    await expect(withTenant(database.db, f.a.ceiling, tx => tx.update(marketplacePublicationRequests).set({ payloadChecksum: "f".repeat(64) }).where(eq(marketplacePublicationRequests.id, created.view.request.id)))).rejects.toThrow();
    await expect(withTenant(database.db, f.a.ceiling, tx => tx.update(marketplacePublicationEvents).set({ status: "published" }).where(eq(marketplacePublicationEvents.requestId, created.view.request.id)))).rejects.toThrow();
    expect((await withTenant(database.db, f.foreign.ceiling, tx => tx.select().from(marketplacePublicationIntents).where(eq(marketplacePublicationIntents.requestId, created.view.request.id))))).toEqual([]);
    const workspace = PublicationPreviewWorkspaceSchema.parse((await f.http(f.workspacePath({ listingId: s.source.listingId, listingVersionId: s.source.versionId, variantSkuId: s.source.variantSkuId }))).body);
    expect(workspace.listing.versionId).toBe(s.source.versionId);
    for (const mode of ["INVALID", "rate_limited", "secret"] as const) {
      const scenario = await scene(); if (mode === "INVALID") f.provider.controls.validationStatus = mode;
      else { f.provider.controls.faultKind = "amazon_listing_validation_preview"; f.provider.controls.fault = mode; }
      const done = await finish(scenario); expect(done.result.request.current.status).toBe(mode === "INVALID" ? "validation_failed" : "failed");
      expect(done.result.execution?.state).toBe(mode === "INVALID" ? "succeeded" : "failed"); expect(done.result.access.canContinue).toBe(false);
      const publicText = JSON.stringify(done.result); for (const secret of f.provider.secretValues) expect(publicText).not.toContain(secret);
      await done.child.close(); await f.provider.assertEncryptedFiles([resolve(scenario.node.keys.directory, "state.pe"), resolve(scenario.node.keys.directory, "execution.pe")]);
      f.provider.controls.fault = "none"; f.provider.controls.faultKind = null; f.provider.controls.validationStatus = "ACCEPTED";
    }
    const rows = await f.previewRows(); expect(rows.requests.every(value => value.action === "amazon_validation_preview")).toBe(true);
    expect(await zeroPlatformWrites()).toEqual({ paid: 0, submitted: 0, syncs: 0 });
    expect(createHash("sha256").update(publicationPreviewRequestText(targetOf(created.input))).digest("hex")).toBe(created.input.requestChecksum);
    proof.push({ case: "immutable_failure_and_cancel", requestId: created.view.request.id, cancelledBeforeHttp: true,
      futureScheduledBeforeDueHttp: 0, sourceReasons: ["not_bound", "node_offline"], providerCases: ["INVALID", "rate_limited", "secret"], arbitrarySubmissionRequests: 0, paid: 0 });
  });
});
