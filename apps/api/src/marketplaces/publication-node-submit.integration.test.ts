import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { MarketplacePublicationEventViewSchema } from "@yummyai/contracts/marketplace/publication";
import { PublicationSubmitRequestViewSchema, PublicationSubmitTargetSchema,
  publicationSubmitRequestText, STORE_NODE_PUBLICATION_SUBMIT_OPERATION, STORE_NODE_PUBLICATION_STATUS_OPERATION } from "@yummyai/contracts/marketplace/publication-submit";
import { STORE_NODE_EXECUTION_PROTOCOL, StoreNodeExecutionClaimSchema } from "@yummyai/contracts/marketplace/store-node-execution";
import { createQueue, QueueName } from "@yummyai/jobs";
import { connectDatabase, memberships, marketplacePublicationRequests, marketplacePublicationIntents,
  marketplacePublicationNodeOperations, marketplacePublicationNodeResults, listings, withTenant } from "@yummyai/database";
import { requirePublicationNodeSubmitEnvironment } from "../../../../tools/testing/publication-node-submit-environment.mjs";
import { executionBounded } from "./publication-node-preview-provider.test-fixture.js";
import { nodeExecutionPermissions, nodeExecutionSha, safeCode, executionCleanupDiagnostic } from "./publication-node-preview.test-fixture.js";
import { publicationNodeSubmitFixture, submissionApi, submitFixtureDigest } from "./publication-node-submit.test-fixture.js";

const isolated = requirePublicationNodeSubmitEnvironment(process.env, "current"), database = connectDatabase(isolated.url),
  f = publicationNodeSubmitFixture(database), proof: object[] = [];
let queue: ReturnType<typeof createQueue> | undefined;
const lookup = (input: { requestKey: string; requestChecksum: string }) => ({ requestKey: input.requestKey, requestChecksum: input.requestChecksum });
const count = (kind: string) => f.original.provider.records.filter(row => row.node && row.kind === kind).length;
async function events(id: string) {
  const response = await f.original.http(`/v1/marketplace-publications/${id}/events`);
  expect(response.status).toBe(200); return MarketplacePublicationEventViewSchema.array().parse(response.body);
}
async function immutable(id: string) {
  const rows = await f.readOnlyRows(), request = rows.requests.find(value => value.id === id), intent = rows.intents.find(value => value.requestId === id);
  return { requestSha256: submitFixtureDigest(request), intentSha256: submitFixtureDigest(intent), payloadChecksum: request?.payloadChecksum,
    operationSha256: submitFixtureDigest(rows.operations.filter(value => value.requestId === id && value.kind === "submit")),
    parentRequestId: request?.parentRequestId, target: intent?.target };
}
async function business() {
  return withTenant(database.db, f.original.a.ceiling, async tx => (await tx.execute<{ paid: number; syncs: number }>(sql`select
    (select count(*)::int from ai_budget_ledger) paid,(select count(*)::int from marketplace_listing_sync_requests) syncs`))[0]!);
}
async function done(s: Awaited<ReturnType<typeof f.scene>>, original?: Awaited<ReturnType<typeof f.input>>, options: Parameters<typeof f.original.workNode>[1] = {}) {
  const input = original ?? await f.input(s.preview.request.id), created = await f.create(input), child = await f.original.workNode(s.node.keys, options),
    terminal = await f.waitOperation(created.execution.id, child);
  return { input, created, child, terminal, view: await f.get(created.request.id) };
}
async function readStatus(s: Awaited<ReturnType<typeof f.scene>>, id: string) {
  const input = await f.statusInput(id), created = await f.createStatus(id, input), child = await f.original.workNode(s.node.keys);
  const terminal = await f.waitOperation(created.execution.id, child);
  await expect.poll(async () => (await f.journal(s.node.keys)).completed, { timeout: 20_000 }).toBe(true);
  await child.close(); const receipt = await f.statusReceipt(input); expect(receipt.found).toBe(true);
  return { input, created, terminal, result: receipt.operation! };
}
beforeAll(async () => { await f.initialize(); queue = createQueue(QueueName.Publication); });
afterEach(async () => {
  f.original.provider.controls.fault = "none"; f.original.provider.controls.faultKind = null;
  f.original.provider.controls.submissionStatus = "ACCEPTED"; f.original.provider.controls.listingStatus = "BUYABLE";
  await f.original.stopChildren();
  for (const who of [f.original.a, f.original.peer, f.original.foreign]) {
    await withTenant(database.db, who.ceiling, tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, who.membershipId)));
    await f.original.rights(who);
  }
});
afterAll(async () => {
  const errors: unknown[] = [], diagnostics: ReturnType<typeof executionCleanupDiagnostic> = [];
  for (const [phase, close] of [["queue", () => queue?.close()], ["fixture", () => f.close()], ["database", () => database.client.end()]] as const)
    try { await close(); } catch (error) { errors.push(error); diagnostics.push(...executionCleanupDiagnostic(error, phase)); }
  await writeFile(resolve(isolated.lane, isolated.nonce + "-current-proof.json"), JSON.stringify({ operation: "74c2e8b1", cases: proof,
    io: f.io, cleanup: f.original.evidence, cleanupFailureCount: errors.length, diagnostics,
    providerBoundary: "synthetic_https_after_original_official_policy", actualSellerPublication: false }));
  if (errors.length) throw new AggregateError(errors, "publication_node_submit_cleanup_failed");
});

describe("original single Publication submission and separate status through actual node CLI/mTLS", () => {
  it("public_submit_status_original_owner preserves the passed preview and makes exactly two HTTP calls per explicit operation", async () => {
    const s = await f.scene(), baseline = await business(), counts = f.original.provider.counts(), queueBefore = await queue!.getJobCounts(),
      input = await f.input(s.preview.request.id), created = await f.create(input);
    expect(f.original.provider.counts()).toEqual(counts); expect(created.request.action).toBe("amazon_submit");
    expect(created.request.parentRequestId).toBe(s.preview.request.id); expect(created.request.payloadChecksum).toBe(s.preview.request.payloadChecksum);
    expect(created.intent.target).toEqual(PublicationSubmitTargetSchema.parse(Object.fromEntries(Object.entries(input)
      .filter(([key]) => !["requestKey", "requestChecksum", "acknowledgeReplacement"].includes(key)))));
    expect(created.execution.state).toBe("waiting_node"); expect(await queue!.getJob(created.request.id)).toBeUndefined();
    const child = await f.original.workNode(s.node.keys), terminal = await f.waitOperation(created.execution.id, child);
    expect(terminal, JSON.stringify({ ...terminal, child: child.evidence.states, code: child.evidence.stderrCode })).toMatchObject({ state: "succeeded", errorCode: null });
    await expect.poll(async () => (await f.journal(s.node.keys)).completed, { timeout: 20_000 }).toBe(true); await child.close();
    const submitted = await f.get(created.request.id); expect(submitted.request.current.status).toBe("submission_accepted");
    expect(submitted.result).toMatchObject({ status: "submission_accepted", externalListingId: s.source.sku, payloadChecksum: input.payloadChecksum });
    expect(submitted.result!.externalSubmissionId).toMatch(/^SYNTHETIC-SUBMISSION-/);
    const calls = f.original.provider.records.filter(row => row.node).slice(Object.values(counts).reduce((a, b) => a + (b ?? 0), 0));
    expect(calls.map(row => [row.kind, row.method, row.status])).toEqual([["amazon_lwa", "POST", 200], ["amazon_listing_submit", "PUT", 200]]);
    expect(calls[1]).toMatchObject({ originalSubmissionTarget: true, originalSubmissionBody: true, credentialAccepted: true });
    expect((await f.journal(s.node.keys)).lease.operation).toBe(STORE_NODE_PUBLICATION_SUBMIT_OPERATION);
    const requestBeforeStatus = await immutable(created.request.id), status = await readStatus(s, created.request.id);
    expect(status.terminal.state).toBe("succeeded"); expect(status.result.result).toMatchObject({ status: "published", sourceSubmissionId: submitted.result!.externalSubmissionId });
    expect(status.result.adoptedAsRequestStatus).toBe(true); expect((await f.get(created.request.id)).request.current.status).toBe("published");
    expect((await f.journal(s.node.keys)).lease.operation).toBe(STORE_NODE_PUBLICATION_STATUS_OPERATION);
    expect((await f.journal(s.node.keys)).rows.map(row => [row.ordinal, row.requestClass, row.stepAcknowledged]))
      .toEqual([[1, "amazon_lwa", true], [2, "amazon_listing_status", true]]);
    expect((await f.original.provider.counts()).amazon_listing_submit! - (counts.amazon_listing_submit ?? 0)).toBe(1);
    expect((await f.original.provider.counts()).amazon_listing_status! - (counts.amazon_listing_status ?? 0)).toBe(1);
    const savedResults = (await f.readOnlyRows()).results.filter(row => row.requestId === created.request.id);
    expect(savedResults).toHaveLength(2); expect(savedResults.every(row => row.adoptedAsRequestStatus)).toBe(true);
    await expect(withTenant(database.db, f.original.a.ceiling, tx => tx.update(marketplacePublicationNodeResults).set({ adoptedAsRequestStatus: false })
      .where(eq(marketplacePublicationNodeResults.id, savedResults[0]!.id)))).rejects.toBeDefined();
    expect(await immutable(created.request.id)).toEqual(requestBeforeStatus); expect(await queue!.getJobCounts()).toEqual(queueBefore);
    expect(f.original.provider.records.filter(row => !row.node && row.kind === "amazon_lwa")).toEqual([]);
    expect(await business()).toEqual(baseline); f.noSecrets(await f.get(created.request.id)); f.noSecrets(await events(created.request.id));
    await f.original.provider.assertEncryptedFiles(["execution.pe", "state.pe", "private-key.pem"].map(path => resolve(s.node.keys.directory, path)));
    proof.push({ case: "public_submit_status_original_owner", parentId: s.preview.request.id, requestId: created.request.id,
      submitExecutionId: created.execution.id, statusExecutionId: status.created.execution.id, submitHttp: 2, statusHttp: 2, physicalPut: 1, centralQueueDelta: 0, paidDelta: 0 });
  });

  it("private_submit_without_public_configuration uses the original private credential and keeps old cap-only discovery bounded", async () => {
    const s = await f.scene(f.original.a, "amazon_private"), input = await f.input(s.preview.request.id), created = await f.create(input), before = f.original.provider.counts();
    const state = await f.original.rows(s.node.nodeId), claim = await f.original.tls("/v1/store-nodes/runtime/executions/claim", {
      protocol: STORE_NODE_EXECUTION_PROTOCOL, nodeId: s.node.nodeId, certificateGeneration: input.certificateGeneration, sessionId: state.node!.sessionId,
      supportedAuthorizationModes: ["amazon_private"] }, s.node.socket);
    expect(claim.status).toBe(200); expect(StoreNodeExecutionClaimSchema.parse(claim.body)).toMatchObject({ state: "empty", lease: null });
    expect(f.original.provider.counts()).toEqual(before);
    const child = await f.original.workNode(s.node.keys, { amazon: "missing" }); expect((await f.waitOperation(created.execution.id, child)).state).toBe("succeeded");
    await expect.poll(async () => (await f.journal(s.node.keys)).completed, { timeout: 20_000 }).toBe(true); await child.close();
    const record = f.original.provider.records.filter(row => row.kind === "amazon_lwa").at(-1)!;
    expect(record).toMatchObject({ application: "private", credentialAccepted: true, node: true, status: 200 });
    const history = await f.original.executions.history(await f.original.current(), s.store.id);
    expect(history.items.some(row => row.id === created.execution.id)).toBe(false); f.noSecrets(await f.get(created.request.id));
    proof.push({ case: "private_submit_without_public_configuration", requestId: created.request.id, legacyCapOnlyClaim: "empty", privateApplicationAccepted: true });
  });

  it("same_original_key_and_lost_201_receipt do not create a second child or PUT after current primary changes", async () => {
    const s = await f.scene(), input = await f.input(s.preview.request.id), before = f.original.provider.counts(), postBefore = f.io.filter(row => row.method === "POST").length;
    await f.lose201(submissionApi + "/requests", input);
    const original = await f.receipt(input); expect(original.found).toBe(true); const id = original.request!.request.id;
    expect(f.io.filter(row => row.method === "POST").length - postBefore).toBe(1); expect(f.original.provider.counts()).toEqual(before);
    const repeated = await Promise.all([f.create(input), f.create(input)]); expect(repeated.map(row => row.request.id)).toEqual([id, id]);
    const mismatch = { ...input, sku: input.sku + "-UNRELATED" };
    mismatch.requestChecksum = nodeExecutionSha(publicationSubmitRequestText(PublicationSubmitTargetSchema.parse(Object.fromEntries(Object.entries(mismatch)
      .filter(([key]) => !["requestKey", "requestChecksum", "acknowledgeReplacement"].includes(key))))));
    const rejected = await f.http(submissionApi + "/requests", mismatch); expect(rejected.status).toBe(409);
    expect(f.original.provider.counts()).toEqual(before);
    const current = await f.original.listings.getWorkspace(await f.original.current(), s.source.listingId), saved = await f.original.listings.saveVersion(await f.original.current(), s.source.listingId,
      { ...current.version.content, title: current.version.content.title + " reviewed later" });
    await f.original.listings.approveVersion(await f.original.current(), s.source.listingId, saved.id);
    const stable = await f.receipt(input); expect(stable.request!.request.id).toBe(id); expect(stable.request!.intent.target.listingVersionId).toBe(s.source.versionId);
    expect(stable.request!.request.payloadChecksum).toBe(original.request!.request.payloadChecksum);
    const rows = await f.readOnlyRows(); expect(rows.requests.filter(row => row.parentRequestId === s.preview.request.id && row.action === "amazon_submit")).toHaveLength(1);
    const peer = await f.http(submissionApi + "/receipt?" + new URLSearchParams(lookup(input)), undefined, f.original.peer);
    expect(peer.status).toBe(200); expect(peer.body).toMatchObject({ found: false, request: null });
    const foreign = await f.http(submissionApi + "/requests/" + id, undefined, f.original.foreign); expect(foreign.status).toBe(404);
    proof.push({ case: "same_original_key_and_lost_201_receipt", originalRequestId: id, requestKey: input.requestKey,
      lostResponseActual201: true, initialPostCount: 1, exactChildCount: 1, providerDelta: 0, immutableVersionId: s.source.versionId });
  });

  it("cached_step_and_completion_ack_restart replay the original encrypted receipt with exactly one physical formal PUT", async () => {
    for (const loss of ["step", "complete"] as const) {
      const s = await f.scene(), beforePut = count("amazon_listing_submit"), input = await f.input(s.preview.request.id), created = await f.create(input), child = await f.original.workNode(s.node.keys, { loss });
      await expect.poll(async () => { try { return JSON.parse(await readFile(child.lossMarker, "utf8")) as unknown; } catch { return null; } }, { timeout: 30_000 })
        .toEqual({ rpc: loss, status: 200, explicitSyntheticLoss: true });
      await child.close(); const cached = await f.journal(s.node.keys), counts = f.original.provider.counts();
      expect(cached.lease.id).toBe(created.execution.id); expect(cached.rows.map(row => row.state)).toEqual(["received", "received"]);
      const restarted = await f.original.workNode(s.node.keys, { amazon: loss === "complete" ? "missing" : "valid" });
      try {
        expect((await f.waitOperation(created.execution.id, restarted)).state).toBe("succeeded");
        await expect.poll(async () => (await f.journal(s.node.keys)).completed, { timeout: 25_000 }).toBe(true);
        const final = await f.journal(s.node.keys); expect(final.lease).toEqual(cached.lease);
        expect(final.rows.map(row => [row.ordinal, row.requestClass, row.stepAcknowledged])).toEqual([[1, "amazon_lwa", true], [2, "amazon_listing_submit", true]]);
        expect(count("amazon_listing_submit") - beforePut).toBe(1); expect(f.original.provider.counts()).toEqual(counts);
        expect((await f.receipt(input)).request!.request.id).toBe(created.request.id); f.noSecrets(await f.get(created.request.id));
        proof.push({ case: "cached_ack_restart", loss, requestId: created.request.id, executionId: created.execution.id,
          completionChecksum: final.completion!.payloadChecksum, restartProviderDelta: 0, physicalPut: 1, explicitMtlSTransportLoss: true });
      } finally { await restarted.close(); }
    }
  });

  it("unknown_put_is_not_proven_by_existing_buyable_status keeps the original unknown request and never repeats its mutation", async () => {
    const s = await f.scene(), beforePut = count("amazon_listing_submit");
    f.original.provider.controls.fault = "lose"; f.original.provider.controls.faultKind = "amazon_listing_submit";
    const result = await done(s); expect(result.terminal.state).toBe("unknown_outcome"); expect(result.view.request.current.status).toBe("reconciliation_required");
    await expect.poll(async () => (await f.journal(s.node.keys)).completed, { timeout: 20_000 }).toBe(true); await result.child.close();
    const original = await immutable(result.created.request.id), beforeEvents = await events(result.created.request.id), counts = f.original.provider.counts();
    expect((await f.journal(s.node.keys)).rows.map(row => [row.requestClass, row.state])).toEqual([["amazon_lwa", "received"], ["amazon_listing_submit", "unknown"]]);
    f.original.provider.controls.fault = "none"; const restarted = await f.original.workNode(s.node.keys);
    await expect.poll(() => restarted.evidence.states.some(row => row.state === "waiting" || row.state === "execution_finished"), { timeout: 20_000 }).toBe(true);
    await restarted.close(); expect(f.original.provider.counts()).toEqual(counts); expect(count("amazon_listing_submit") - beforePut).toBe(1);
    const status = await readStatus(s, result.created.request.id); expect(status.input.sourceSubmissionId).toBeNull();
    expect(status.result.result).toMatchObject({ status: "published", sourceSubmissionId: null }); expect(status.result.adoptedAsRequestStatus).toBe(false);
    expect((await f.get(result.created.request.id)).request.current.status).toBe("reconciliation_required");
    expect(await immutable(result.created.request.id)).toEqual(original); expect(await events(result.created.request.id)).toEqual(beforeEvents);
    expect(count("amazon_listing_submit") - beforePut).toBe(1); f.noSecrets(status.result);
    proof.push({ case: "unknown_put_is_not_proven_by_existing_buyable_status", requestId: result.created.request.id,
      readId: status.result.id, observedBuyable: true, adoptedAsRequestStatus: false, physicalPut: 1, restartPutDelta: 0 });
  });

  it("accepted_status_processing_rate_limit_then_explicit_read retains the original submission and never reissues its PUT", async () => {
    const s = await f.scene(), result = await done(s); expect(result.terminal.state).toBe("succeeded");
    await expect.poll(async () => (await f.journal(s.node.keys)).completed, { timeout: 20_000 }).toBe(true); await result.child.close();
    const beforePut = count("amazon_listing_submit"), original = await immutable(result.created.request.id);
    f.original.provider.controls.listingStatus = "PROCESSING"; const processing = await readStatus(s, result.created.request.id);
    expect(processing.result.result?.status).toBe("sync_pending"); expect(processing.result.adoptedAsRequestStatus).toBe(true);
    f.original.provider.controls.fault = "rate_limited"; f.original.provider.controls.faultKind = "amazon_listing_status";
    const limited = await readStatus(s, result.created.request.id); expect(limited.terminal).toMatchObject({ state: "failed", errorCode: "store_node_upstream_rate_limited" });
    expect(limited.result.result).toBeNull(); expect(limited.result.adoptedAsRequestStatus).toBe(false);
    f.original.provider.controls.fault = "none"; f.original.provider.controls.listingStatus = "BUYABLE";
    const published = await readStatus(s, result.created.request.id); expect(published.result.result?.status).toBe("published");
    expect((await f.get(result.created.request.id)).request.current.status).toBe("published"); expect(count("amazon_listing_submit")).toBe(beforePut);
    expect(await immutable(result.created.request.id)).toEqual(original);
    proof.push({ case: "accepted_status_processing_rate_limit_then_explicit_read", requestId: result.created.request.id,
      statusOperations: 3, failedReadCode: limited.terminal.errorCode, extraPut: 0 });
  });

  it("per_http_and_late_authority_fences reject a withdrawn original bit before PUT and discard a real late accepted result", async () => {
    for (const phase of ["before_put", "late_result"] as const) {
      const s = await f.scene(), input = await f.input(s.preview.request.id), created = await f.create(input),
        held = f.original.provider.arm(phase === "before_put" ? "amazon_lwa" : "amazon_listing_submit"), beforePut = count("amazon_listing_submit"), child = await f.original.workNode(s.node.keys);
      try {
        await executionBounded(Promise.race([held.entered.promise, child.done.then(() => { throw new Error("publication_submit_child_before_gate"); })]), "publication_submit_real_provider_gate_deadline", 30_000);
        const original = await immutable(created.request.id);
        await f.original.rights(f.original.a, nodeExecutionPermissions.filter(value => value !== Permission.ListingPublish)); held.release.release();
        const terminal = await f.waitOperation(created.execution.id, child); expect(terminal.state).toBe("authority_changed");
        expect(terminal.errorCode).toBe("store_node_authority_changed");
        expect(count("amazon_listing_submit") - beforePut).toBe(phase === "before_put" ? 0 : 1);
        const rows = await f.readOnlyRows(); expect(rows.events.filter(row => row.requestId === created.request.id).some(row => ["submission_accepted", "published"].includes(row.status))).toBe(false);
        expect(await immutable(created.request.id)).toEqual(original); expect((await f.original.accountRows(s.store.id)).snapshots).toHaveLength(1);
        await f.original.rights(f.original.a); const counts = f.original.provider.counts(), postCount = f.io.filter(row => row.method === "POST").length;
        expect((await f.receipt(input)).request!.request.id).toBe(created.request.id); expect(f.original.provider.counts()).toEqual(counts);
        expect(f.io.filter(row => row.method === "POST").length).toBe(postCount);
        proof.push({ case: "per_http_and_late_authority_fences", phase, requestId: created.request.id, executionId: created.execution.id,
          physicalPut: phase === "before_put" ? 0 : 1, adoptedResultEvents: 0, recoveryPosts: 0 });
      } finally { held.release.release(); await child.close(); await f.original.rights(f.original.a); }
    }
  });

  it("waiting_cancel_source_conflict_immutable_rls preserve exact original targets without central fallback or provider IO", async () => {
    const s = await f.scene(), input = await f.input(s.preview.request.id), created = await f.create(input), before = f.original.provider.counts(),
      original = await immutable(created.request.id), queueBefore = await queue!.getJobCounts();
    const forged = { ...input, requestKey: createEntityId(), capabilitySnapshotId: createEntityId() };
    forged.requestChecksum = nodeExecutionSha(publicationSubmitRequestText(PublicationSubmitTargetSchema.parse(Object.fromEntries(Object.entries(forged)
      .filter(([key]) => !["requestKey", "requestChecksum", "acknowledgeReplacement"].includes(key))))));
    expect((await f.http(submissionApi + "/requests", forged)).status).toBe(409);
    expect((await f.http(submissionApi + "/requests/" + created.request.id, undefined, f.original.foreign)).status).toBe(404);
    expect(await withTenant(database.db, f.original.foreign.ceiling, tx => tx.select().from(marketplacePublicationRequests).where(eq(marketplacePublicationRequests.id, created.request.id)))).toEqual([]);
    expect(await withTenant(database.db, f.original.foreign.ceiling, tx => tx.select().from(marketplacePublicationNodeOperations).where(eq(marketplacePublicationNodeOperations.requestId, created.request.id)))).toEqual([]);
    await expect(withTenant(database.db, f.original.a.ceiling, tx => tx.update(marketplacePublicationRequests).set({ payloadChecksum: "f".repeat(64) })
      .where(and(eq(marketplacePublicationRequests.id, created.request.id), eq(marketplacePublicationRequests.tenantId, f.original.a.tenantId))))).rejects.toBeDefined();
    await expect(withTenant(database.db, f.original.a.ceiling, tx => tx.update(marketplacePublicationIntents).set({ authorityCeiling: f.original.peer.ceiling })
      .where(eq(marketplacePublicationIntents.requestId, created.request.id)))).rejects.toBeDefined();
    await expect(withTenant(database.db, f.original.a.ceiling, tx => tx.update(marketplacePublicationNodeOperations).set({ requestChecksum: "f".repeat(64) })
      .where(and(eq(marketplacePublicationNodeOperations.requestId, created.request.id), eq(marketplacePublicationNodeOperations.kind, "submit"))))).rejects.toBeDefined();
    const cancelled = await f.http(submissionApi + "/requests/" + created.request.id + "/cancel", { reason: "Synthetic operator cancellation before the original node claims" });
    expect(cancelled.status, JSON.stringify({ status: cancelled.status, code: safeCode(cancelled.body) })).toBe(200);
    expect(PublicationSubmitRequestViewSchema.parse(cancelled.body)).toMatchObject({ request: { current: { status: "cancelled" } }, execution: { state: "cancelled" } });
    expect(await immutable(created.request.id)).toEqual(original); expect(f.original.provider.counts()).toEqual(before);
    expect(await queue!.getJobCounts()).toEqual(queueBefore); expect(await business()).toEqual({ paid: 0, syncs: 0 });
    const statusLookup = await f.http(submissionApi + "/status-receipt?" + new URLSearchParams({ requestKey: createEntityId(), requestChecksum: "0".repeat(64) }));
    expect(statusLookup.status).toBe(200); expect(statusLookup.body).toMatchObject({ found: false, operation: null });
    f.noSecrets(cancelled.body); proof.push({ case: "waiting_cancel_source_conflict_immutable_rls", requestId: created.request.id, providerDelta: 0, centralQueueDelta: 0,
      immutableRequest: true, immutableIntent: true, foreignRows: 0 });
  });

  it("status_birth_self_is_not_expanded_by_parent_tenant_or_later_promotion rejects another original Listing before any status HTTP", async () => {
    const s = await f.scene(), submitted = await done(s);
    expect(submitted.terminal.state).toBe("succeeded");
    await expect.poll(async () => (await f.journal(s.node.keys)).completed, { timeout: 20_000 }).toBe(true); await submitted.child.close();
    const parent = await immutable(submitted.created.request.id), beforeEvents = await events(submitted.created.request.id);
    await f.original.rights(f.original.a, nodeExecutionPermissions, "self");
    const input = await f.statusInput(submitted.created.request.id), created = await f.createStatus(submitted.created.request.id, input),
      born = (await f.readOnlyRows()).operations.find(row => row.id === created.id)!;
    expect(born.authorityCeiling.dataScope).toBe("self");
    expect((await f.readOnlyRows()).operations.find(row => row.requestId === submitted.created.request.id && row.kind === "submit")!.authorityCeiling.dataScope).toBe("tenant");
    await f.original.rights(f.original.a, nodeExecutionPermissions, "tenant");
    const ceiling = f.original.a.ceiling;
    const moved = await withTenant(database.db, ceiling, tx => tx.update(listings).set({ createdBy: f.original.peer.userId })
      .where(and(eq(listings.id, s.source.listingId), eq(listings.createdBy, f.original.a.userId))).returning({ id: listings.id }));
    expect(moved).toEqual([{ id: s.source.listingId }]);
    const counts = f.original.provider.counts(); let child: Awaited<ReturnType<typeof f.original.workNode>> | undefined;
    try {
      child = await f.original.workNode(s.node.keys);
      const terminal = await f.waitOperation(created.execution.id, child);
      expect(terminal).toMatchObject({ state: "authority_changed", errorCode: "store_node_authority_changed" });
      expect(f.original.provider.counts()).toEqual(counts);
      const receipt = await f.http(submissionApi + "/status-receipt?" + new URLSearchParams(lookup(input)));
      expect(receipt.status).toBe(404); expect(JSON.stringify(receipt.body)).not.toContain(s.source.title);
      expect((await f.http(submissionApi + "/requests/" + submitted.created.request.id)).status).toBe(404);
      expect((await f.readOnlyRows()).results.some(row => row.operationId === created.id)).toBe(false);
      expect(await immutable(submitted.created.request.id)).toEqual(parent); expect(await events(submitted.created.request.id)).toEqual(beforeEvents);
      expect((await f.readOnlyRows()).operations.find(row => row.id === created.id)).toEqual(born);
      proof.push({ case: "status_birth_self_is_not_expanded_by_parent_tenant_or_later_promotion", requestId: submitted.created.request.id,
        operationId: created.id, parentBirthScope: "tenant", statusBirthScope: "self", currentScope: "tenant", newOwner: "same_tenant_peer",
        statusProviderDelta: 0, receiptStatus: receipt.status, adoptedStatusResults: 0 });
    } finally {
      await child?.close();
      const restored = await withTenant(database.db, ceiling, tx => tx.update(listings).set({ createdBy: f.original.a.userId })
        .where(and(eq(listings.id, s.source.listingId), eq(listings.createdBy, f.original.peer.userId))).returning({ id: listings.id }));
      expect(restored).toEqual([{ id: s.source.listingId }]); await f.original.rights(f.original.a);
    }
  });

  it("workspace_current_tenant_stamp_retains_parent_self_birth when the original actor is promoted before explicit submission", async () => {
    await f.original.rights(f.original.a, nodeExecutionPermissions, "self");
    const s = await f.scene(), beforeRows = await f.readOnlyRows(),
      parentIntent = beforeRows.intents.find(row => row.requestId === s.preview.request.id)!;
    expect(parentIntent.authorityCeiling.dataScope).toBe("self");
    const beforeSession = await f.original.http("/v1/identity/session"); expect(beforeSession.status).toBe(200);
    const bornSession = ErpSessionViewSchema.parse(beforeSession.body); expect(bornSession.dataScope).toBe("self");
    await f.original.rights(f.original.a, nodeExecutionPermissions, "tenant");
    const sessionResponse = await f.original.http("/v1/identity/session"); expect(sessionResponse.status).toBe(200);
    const currentSession = ErpSessionViewSchema.parse(sessionResponse.body);
    expect(currentSession).toMatchObject({ userId: f.original.a.userId, tenantId: f.original.a.tenantId, dataScope: "tenant" });
    const currentAuthority = nodeExecutionSha(erpSessionAuthority(currentSession));
    expect(currentAuthority).not.toBe(nodeExecutionSha(erpSessionAuthority(bornSession)));
    const counts = f.original.provider.counts(), queueBefore = await queue!.getJobCounts(), businessBefore = await business(),
      workspace = await f.workspace(s.preview.request.id);
    expect(workspace.context).toEqual({ actorId: currentSession.userId, tenantId: currentSession.tenantId, authority: currentAuthority });
    expect(workspace).toMatchObject({ access: { canRead: true, canSubmit: true }, reason: "ready" });
    expect(workspace.target).toMatchObject({ listingId: s.source.listingId, listingVersionId: s.source.versionId, previewRequestId: s.preview.request.id });
    const input = await f.input(s.preview.request.id), created = await f.create(input), rows = await f.readOnlyRows(),
      intent = rows.intents.find(row => row.requestId === created.request.id)!,
      operation = rows.operations.find(row => row.requestId === created.request.id && row.kind === "submit")!;
    expect(created.execution.state).toBe("waiting_node"); expect(created.result).toBeNull();
    expect(intent.authorityCeiling.dataScope).toBe("self"); expect(operation.authorityCeiling).toEqual(intent.authorityCeiling);
    expect(rows.intents.find(row => row.requestId === s.preview.request.id)).toEqual(parentIntent);
    expect(f.original.provider.counts()).toEqual(counts); expect(await queue!.getJobCounts()).toEqual(queueBefore);
    const cancelled = await f.http(submissionApi + "/requests/" + created.request.id + "/cancel", { reason: "Synthetic current-stamp and parent-birth check completed before node execution" });
    expect(cancelled.status).toBe(200);
    expect(PublicationSubmitRequestViewSchema.parse(cancelled.body)).toMatchObject({ request: { current: { status: "cancelled" } }, execution: { state: "cancelled" } });
    expect((await f.receipt(input)).request!.request.id).toBe(created.request.id);
    expect(f.original.provider.counts()).toEqual(counts); expect(await business()).toEqual(businessBefore);
    proof.push({ case: "workspace_current_tenant_stamp_retains_parent_self_birth", requestId: created.request.id,
      parentRequestId: s.preview.request.id, parentBirthScope: "self", currentScope: "tenant", childBirthScope: "self",
      actualSessionAuthority: currentAuthority, workspaceAuthority: workspace.context.authority, providerDelta: 0, cancelledBeforeExecution: true });
  });
});
