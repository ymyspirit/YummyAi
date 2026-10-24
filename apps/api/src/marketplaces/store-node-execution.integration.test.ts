import { createHash, createPrivateKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { StoreNodeWorkspaceSchema, STORE_NODE_PROTOCOL } from "@yummyai/contracts/marketplace/store-node";
import { STORE_NODE_EXECUTION_PROTOCOL, StoreNodeExecutionWorkspaceSchema, StoreNodeExecutionViewSchema, StoreNodeExecutionReceiptSchema,
  StoreNodeExecutionClaimSchema, StoreNodeExecutionHistorySchema, StoreNodeExecutionCallSchema, StoreNodeExecutionLeaseSchema, storeNodeExecutionRequestText } from "@yummyai/contracts/marketplace/store-node-execution";
import { connectDatabase, memberships, withTenant } from "@yummyai/database";
import { openStoreNodeSealedCredential } from "@yummyai/marketplace-connectors";
import { openStoreNodeJournal } from "../../../store-api-node/src/identity.js";
import { requireStoreNodeExecutionEnvironment } from "../../../../tools/testing/require-store-node-execution-environment.mjs";
import { executionBounded } from "./store-node-execution-provider.test-fixture.js";
import { executionCleanupDiagnostic, lane, nodeExecutionSha, safeCode, storeNodeExecutionFixture } from "./store-node-execution.test-fixture.js";

const isolated = requireStoreNodeExecutionEnvironment(), database = connectDatabase(isolated.url), f = storeNodeExecutionFixture(database), proof: object[] = [];
const rootPath = (accountId: string) => `/v1/marketplace-accounts/${accountId}/node-executions`;
const terminal = ["succeeded", "failed", "unknown_outcome", "authority_changed", "cancelled", "expired"];
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value !== null && typeof value === "object"
  ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => JSON.stringify(key) + ":" + stable(child)).join(",")}}` : JSON.stringify(value) ?? "null";
async function scene(platform: "etsy" | "amazon" = "etsy", who = f.a) {
  const store = await f.createStore(who, platform), node = await f.bindNode(store.id, await f.initNode(), who);
  return { store, node, who };
}
async function get(accountId: string, id: string, who = f.a) {
  const response = await f.http(rootPath(accountId) + "/" + id, undefined, who);
  expect(response.status, JSON.stringify({ status: response.status, code: safeCode(response.body) })).toBe(200);
  return StoreNodeExecutionViewSchema.parse(response.body);
}
async function waitExecution(accountId: string, id: string, child: Awaited<ReturnType<typeof f.workNode>>, who = f.a) {
  const deadline = Date.now() + 60_000;
  let result: Awaited<ReturnType<typeof get>> | undefined;
  const failed = (code: "store_node_fixture_work_cli_exited" | "store_node_fixture_execution_deadline") => {
    const diagnostic = { code, executionId: id, state: result?.state ?? null, phase: result?.phase ?? null, errorCode: result?.errorCode ?? null,
      child: { exitCode: child.evidence.exitCode, signal: child.evidence.signal, code: child.evidence.stderrCode,
        leaked: child.evidence.leaked, states: child.evidence.states.slice(-6) } };
    proof.push({ case: "work_cli_diagnostic", ...diagnostic });
    return new Error("store_node_fixture_work_wait_failed:" + JSON.stringify(diagnostic));
  };
  while (Date.now() < deadline) {
    result = await get(accountId, id, who);
    if (terminal.includes(result.state)) return result;
    if (child.evidence.exited) throw failed("store_node_fixture_work_cli_exited");
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([child.done, new Promise<void>(done => { timer = setTimeout(done, 250); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  throw failed("store_node_fixture_execution_deadline");
}
async function finish(s: Awaited<ReturnType<typeof scene>>, input: unknown = {}, options: Parameters<typeof f.workNode>[1] = {}) {
  const submitted = await f.submit(s.store.id, input, s.who), child = await f.workNode(s.node.keys, options);
  const result = await waitExecution(s.store.id, submitted.view.id, child, s.who);
  return { ...submitted, child, result };
}
async function zeroWrites() {
  return withTenant(database.db, f.a.ceiling, async tx => (await tx.execute<{ paid: number; publications: number; listingSyncs: number }>(sql`select
    (select count(*)::int from ai_budget_ledger) paid,(select count(*)::int from marketplace_publication_requests) publications,
    (select count(*)::int from marketplace_listing_sync_requests) "listingSyncs"`))[0]);
}
const restore = async () => { for (const who of [f.a, f.peer, f.foreign]) {
  await withTenant(database.db, who.ceiling, tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, who.membershipId)));
  await f.rights(who);
} };
beforeAll(() => f.initialize());
afterEach(async () => { f.provider.controls.fault = "none"; f.provider.controls.faultKind = null; f.provider.controls.schemaOutsideDefinition = false;
  await f.stopChildren(); await restore(); });
afterAll(async () => { const errors: Error[] = [], cleanupDiagnostics: ReturnType<typeof executionCleanupDiagnostic> = [];
  const failure = (phase: string, error: unknown) => { const safe = executionCleanupDiagnostic(error, phase); cleanupDiagnostics.push(...safe);
    errors.push(new Error("store_node_current_cleanup_stage:" + JSON.stringify(safe))); };
  try { await f.close(); } catch (error) { failure("fixture_close", error); }
  try { await database.client.end(); } catch (error) { failure("database_close", error); }
  try { await writeFile(resolve(lane, isolated.nonce + "-current-proof.json"), JSON.stringify({ operation: "e6f2c8a1", cases: proof, cleanup: f.evidence, cleanupFailureCount: errors.length, cleanupDiagnostics })); }
  catch (error) { failure("proof_write", error); }
  if (errors.length) throw new AggregateError(errors, "Store node execution cleanup failed");
});

describe("real node CLI, original marketplace owners and mTLS capability execution", () => {
  it("bootstraps a known pending Etsy grant through the actual CLI and original refresh checkpoint before all eight capability reads", async () => {
    const beforeWrites = await zeroWrites(), s = await scene(), initial = await f.accountRows(s.store.id), counts = f.provider.counts();
    expect(initial.snapshots).toHaveLength(0); expect(initial.account?.status).toBe("pending_authorization"); expect(initial.credential?.version).toBe(1);
    const session = await f.http("/v1/identity/session"); expect(session.status).toBe(200); expect(ErpSessionViewSchema.parse(session.body).userId).toBe(f.a.userId);
    const done = await finish(s, { etsyTaxonomyNodeIds: [42, 123] }); expect(done.result.state, JSON.stringify({ code: done.result.errorCode, phase: done.result.phase })).toBe("succeeded");
    const rows = await f.accountRows(s.store.id), delta = f.provider.counts();
    expect(rows.account?.status).toBe("active"); expect(rows.credential?.version).toBe(2); expect(rows.account?.credentialRefreshState).toBe("known");
    expect(rows.snapshots).toHaveLength(1); expect(done.result.snapshot?.id).toBe(rows.snapshots[0]!.id); expect(done.result.snapshotVersion).toBe(1);
    const expected = { etsy_refresh: 1, etsy_shop: 1, etsy_sections: 1, etsy_return_policies: 1, etsy_taxonomy: 1,
      etsy_shipping_profiles: 1, etsy_readiness_profiles: 1, etsy_taxonomy_properties: 2 };
    for (const [key, count] of Object.entries(expected)) expect((delta[key as keyof typeof delta] ?? 0) - (counts[key as keyof typeof counts] ?? 0), key).toBe(count);
    expect(done.result.snapshot?.sourceChecksum).toBe(createHash("sha256").update(stable(done.result.snapshot!.data)).digest("base64url"));
    expect(JSON.stringify(done.result.snapshot?.data)).toContain('"fixture_unit_amount_minor":12345'); expect(JSON.stringify(done.result.snapshot?.data)).toContain('"fixture_currency":"USD"');
    expect(await zeroWrites()).toEqual(beforeWrites); expect(done.child.evidence.environmentKeys).not.toContain("ETSY_APP_SHARED_SECRET");
    expect(done.child.evidence.environmentKeys).not.toContain("DATABASE_URL"); expect(done.child.evidence.leaked).toBe(false);
    await f.provider.assertEncryptedFiles([resolve(s.node.keys.directory, "execution.pe"), resolve(s.node.keys.directory, "state.pe")]);
    proof.push({ case: "etsy_real_cli", executionId: done.result.id, snapshotId: done.result.snapshotId, originalVersion: rows.credential?.version,
      requestCounts: expected, initialState: "pending_authorization", encryptedJournal: true, extraBusinessWrites: 0 });
  });

  it("runs Amazon private LWA participation PTD schema and meta-schema through the real node with independently checked facts", async () => {
    const s = await scene("amazon"), before = f.provider.counts(), done = await finish(s, { amazonProductTypes: ["PILLOW"] });
    expect(done.result.state, JSON.stringify({ code: done.result.errorCode, phase: done.result.phase })).toBe("succeeded");
    const after = f.provider.counts(), expected = { amazon_lwa: 1, amazon_participations: 1, amazon_product_definition: 1, amazon_schema: 1, amazon_meta_schema: 1 };
    for (const [key, value] of Object.entries(expected)) expect((after[key as keyof typeof after] ?? 0) - (before[key as keyof typeof before] ?? 0)).toBe(value);
    const data = done.result.snapshot!.data as { seller: { sellingPartnerId: string }; productDefinitions: Array<{ productType: string; schemaDocument: unknown; metaSchemaDocument: unknown }> };
    expect(data.seller.sellingPartnerId).toBe(s.store.externalAccountId); expect(data.productDefinitions).toHaveLength(1); expect(data.productDefinitions[0]!.productType).toBe("PILLOW");
    expect(data.productDefinitions[0]!.schemaDocument).toEqual(f.provider.schema); expect(data.productDefinitions[0]!.metaSchemaDocument).toEqual(f.provider.metaSchema);
    expect(done.result.snapshot!.sourceChecksum).toBe(createHash("sha256").update(stable(data)).digest("base64url"));
    expect((await f.accountRows(s.store.id)).credential?.version).toBe(1); expect(done.child.evidence.leaked).toBe(false);
    proof.push({ case: "amazon_real_cli", executionId: done.result.id, snapshotId: done.result.snapshotId, requestCounts: expected, schemaAndMetaSchema: true });
  });

  it("rejects foreign personal contexts forged runtime headers wrong certificates and altered canonical requests without upstream I/O", async () => {
    const s = await scene(), request = await f.intent(s.store.id), before = f.provider.counts();
    const crossed = await f.http(rootPath(s.store.id), undefined, f.foreign); expect(crossed.status).toBe(404);
    const invalid = await f.http(rootPath(s.store.id), { ...request, tenantId: f.foreign.tenantId }); expect(invalid.status).toBe(400);
    const changed = await f.http(rootPath(s.store.id), { ...request, input: { ...request.input, ttlHours: 2 } }); expect(changed.status).toBe(409);
    const submitted = await f.submit(s.store.id), row = (await f.rows(s.node.nodeId)).node!;
    const claim = { protocol: STORE_NODE_EXECUTION_PROTOCOL, nodeId: row.id, certificateGeneration: row.certificateGeneration, sessionId: row.sessionId, supportedAuthorizationModes: ["etsy_oauth"] };
    await expect(f.tls("/v1/store-nodes/runtime/executions/claim", claim, {}, { "x-store-node-id": row.id, "x-tenant-id": f.a.tenantId })).rejects.toThrow();
    const other = await scene(), wrong = await f.tls("/v1/store-nodes/runtime/executions/claim", claim, other.node.socket); expect(wrong.status).toBe(400);
    const exact = await f.tls("/v1/store-nodes/runtime/executions/claim", claim, s.node.socket); expect(exact.status).toBe(200);
    const lease = StoreNodeExecutionClaimSchema.parse(exact.body).lease!; expect(lease.id).toBe(submitted.view.id); expect(lease.accountId).toBe(s.store.id);
    const opened = openStoreNodeSealedCredential(lease.sealedCredential, lease, createPrivateKey({ key: await readFile(resolve(s.node.keys.directory, "private-key.pem")), passphrase: s.node.keys.passphrase }));
    try { expect(Object.keys(opened.payload.credential).sort()).toEqual(["kind", "refreshToken", "userId"]);
      expect(JSON.stringify(opened.payload).includes(f.provider.secrets.centralApp)).toBe(false); expect(JSON.stringify(opened.payload).includes(f.provider.secrets.nodeApp)).toBe(false);
    } finally { opened.key.fill(0); }
    const originalRows = (await f.accountRows(s.store.id)).executions;
    for (const kind of ["request", "claim"] as const) { let failure: unknown;
      try { await withTenant(database.db, f.a.ceiling, tx => tx.execute(kind === "request"
        ? sql`update marketplace_store_node_executions set request_checksum=${"f".repeat(64)} where id=${lease.id}::uuid`
        : sql`update marketplace_store_node_executions set claim_id=${createEntityId()}::uuid where id=${lease.id}::uuid`)); }
      catch (error) { failure = error; }
      const codes: string[] = []; while (failure && typeof failure === "object") { if ("code" in failure && typeof failure.code === "string") codes.push(failure.code); failure = "cause" in failure ? failure.cause : undefined; }
      expect(codes).toContain("23514");
    }
    expect((await f.accountRows(s.store.id)).executions).toEqual(originalRows);
    const foreignRows = await withTenant(database.db, f.foreign.ceiling, tx => tx.execute(sql`select id from marketplace_store_node_executions where id=${lease.id}::uuid`)); expect(foreignRows).toHaveLength(0);
    const call = StoreNodeExecutionCallSchema.parse({ protocol: STORE_NODE_EXECUTION_PROTOCOL, nodeId: row.id, certificateGeneration: row.certificateGeneration,
      sessionId: row.sessionId, executionId: lease.id, claimId: lease.claimId, requestChecksum: lease.requestChecksum });
    const mismatch = await f.tls("/v1/store-nodes/runtime/executions/receipt", { ...call, claimId: createEntityId() }, s.node.socket); expect(mismatch.status).toBe(409);
    expect(f.provider.counts()).toEqual(before); proof.push({ case: "tls_and_original_scope", noProviderRequests: true, executionId: lease.id });
  });

  it("serializes concurrent original HTTP requests and returns exact immutable snapshots and receipts without extra provider calls", async () => {
    const s = await scene(), request = await f.intent(s.store.id), responses = await Promise.all([f.http(rootPath(s.store.id), request), f.http(rootPath(s.store.id), request)]);
    expect(responses.map(value => value.status)).toEqual([201, 201]); const views = responses.map(value => StoreNodeExecutionViewSchema.parse(value.body)); expect(views[0]!.id).toBe(views[1]!.id);
    const changed = { ...request, input: { ...request.input, ttlHours: 48 } }; changed.requestChecksum = nodeExecutionSha(storeNodeExecutionRequestText(s.store.id, changed));
    expect((await f.http(rootPath(s.store.id), changed)).status).toBe(409);
    const child = await f.workNode(s.node.keys), first = await waitExecution(s.store.id, views[0]!.id, child);
    expect(first.state).toBe("succeeded"); await child.close();
    const before = f.provider.counts(), receipt = await f.http(rootPath(s.store.id) + "/receipt", { requestId: request.requestId, requestChecksum: request.requestChecksum });
    expect(receipt.status).toBe(200); expect(StoreNodeExecutionReceiptSchema.parse(receipt.body).execution).toEqual(first);
    const second = await finish(s); expect(second.result.snapshotVersion).toBe(2);
    const historical = await get(s.store.id, first.id); expect(historical.snapshot).toEqual(first.snapshot); expect(historical.snapshotId).not.toBe(second.result.snapshotId);
    const after = f.provider.counts(); expect((after.etsy_refresh ?? 0) - (before.etsy_refresh ?? 0)).toBe(1);
    const noIo = f.provider.counts(); await f.executions.history(await f.current(), s.store.id); await get(s.store.id, first.id); expect(f.provider.counts()).toEqual(noIo);
    proof.push({ case: "original_idempotency_and_history", firstId: first.id, secondId: second.result.id, originalSnapshotId: first.snapshotId, historicalProviderCalls: 0 });
  });

  it("saves only the returned refresh checkpoint after member withdrawal and performs no later shop read or adoption", async () => {
    const s = await scene(), gate = f.provider.arm("etsy_refresh"), submitted = await f.submit(s.store.id), before = f.provider.counts(), child = await f.workNode(s.node.keys);
    try { await executionBounded(Promise.race([gate.entered.promise, child.done.then(() => { throw new Error("store_node_refresh_cli_exited"); })]), "store_node_refresh_gate_deadline");
      const pending = await f.accountRows(s.store.id); expect(pending.account?.credentialRefreshState).toBe("pending"); expect(pending.credential?.version).toBe(1);
      await f.rights(f.a, [Permission.StoreRead, Permission.StoreAuthorize]); gate.release.release();
      await expect.poll(async () => (await f.accountRows(s.store.id)).credential?.version, { timeout: 20_000 }).toBe(2);
      const final = await f.accountRows(s.store.id); expect(final.snapshots).toHaveLength(0); expect(final.account?.credentialRefreshState).toBe("known");
      expect((f.provider.counts().etsy_shop ?? 0) - (before.etsy_shop ?? 0)).toBe(0);
      expect((await f.http(rootPath(s.store.id), await f.intent(s.store.id))).status).toBe(403);
      proof.push({ case: "member_lost_after_refresh_submit", executionId: submitted.view.id, savedUniqueRefresh: true, laterShopRequests: 0, snapshots: 0 });
    } finally { gate.release.release(); await child.close(); }
  });

  it("does not resurrect a revoked certificate or new store authorization generation when the original refresh returns late", async () => {
    const s = await scene(), held = f.provider.arm("etsy_refresh"), submitted = await f.submit(s.store.id), child = await f.workNode(s.node.keys), before = f.provider.counts();
    try { await executionBounded(held.entered.promise, "store_node_revoke_refresh_gate_deadline");
      const view = StoreNodeWorkspaceSchema.parse(await f.service.workspace(await f.current(), s.store.id)), node = view.nodes.find(value => value.id === s.node.nodeId)!;
      await f.service.revoke(await f.current(), s.store.id, node.id, { expectedAuthorizationGeneration: view.authorizationGeneration, expectedBindingRevision: view.binding.revision, expectedCertificateGeneration: node.certificateGeneration });
      held.release.release(); await executionBounded(child.done, "store_node_revoked_certificate_cli_exit_deadline", 25_000); expect(child.evidence.exited).toBe(true);
      const rows = await f.accountRows(s.store.id); expect(rows.credential?.version).toBe(1); expect(rows.snapshots).toHaveLength(0);
      expect((f.provider.counts().etsy_shop ?? 0) - (before.etsy_shop ?? 0)).toBe(0); expect((await f.rows(node.id)).node?.status).toBe("revoked");
      proof.push({ case: "revoked_physical_certificate", executionId: submitted.view.id, checkpointNotAdopted: true, laterReads: 0 });
    } finally { held.release.release(); await child.close(); }

    const revoked = await scene(), gate = f.provider.arm("etsy_refresh"), original = await f.submit(revoked.store.id), counts = f.provider.counts(), worker = await f.workNode(revoked.node.keys);
    try { await executionBounded(Promise.race([gate.entered.promise, worker.done.then(() => { throw new Error("store_node_revoke_authorization_cli_exited"); })]), "store_node_revoke_authorization_gate_deadline");
      const pending = await f.accountRows(revoked.store.id);
      expect(pending.account?.credentialRefreshState).toBe("pending"); expect(pending.credential?.version).toBe(1); expect(pending.credential?.id).toBeDefined();
      await f.authorization.revoke(await f.current(), revoked.store.id);
      const removed = await f.accountRows(revoked.store.id);
      expect(removed.credential).toBeUndefined(); expect(removed.account?.credentialStatus).toBe("revoked");
      expect(removed.account?.authorizationGeneration).not.toBe(pending.account!.authorizationGeneration);
      const beforeRelease = await get(revoked.store.id, original.view.id);
      expect(beforeRelease.state).toBe("authority_changed"); expect(beforeRelease.errorCode).toBe("store_node_authority_changed");
      gate.release.release();
      await executionBounded(worker.done, "store_node_revoked_authorization_cli_exit_deadline", 25_000); expect(worker.evidence.exited).toBe(true);
      const final = await f.accountRows(revoked.store.id);
      expect(final.credential).toBeUndefined(); expect(final.account?.authorizationGeneration).toBe(removed.account!.authorizationGeneration);
      const stored = final.executions.find(value => value.id === original.view.id);
      expect(stored?.credential_id).toBe(pending.credential!.id); expect(stored?.credential_version).toBe(pending.credential!.version);
      expect(final.snapshots).toHaveLength(0); expect((f.provider.counts().etsy_shop ?? 0) - (counts.etsy_shop ?? 0)).toBe(0);
      expect((f.provider.counts().etsy_refresh ?? 0) - (counts.etsy_refresh ?? 0)).toBe(1);
      const noIo = f.provider.counts(), response = await f.http(rootPath(revoked.store.id) + "/receipt", { requestId: original.request.requestId, requestChecksum: original.request.requestChecksum });
      expect(response.status).toBe(200);
      const receipt = StoreNodeExecutionReceiptSchema.parse(response.body);
      expect(receipt.found).toBe(true); expect(receipt.execution).toMatchObject({ id: original.view.id, requestId: original.request.requestId,
        requestChecksum: original.request.requestChecksum, nodeId: revoked.node.nodeId, authorizationGeneration: original.request.authorizationGeneration,
        state: "authority_changed", snapshot: null });
      expect((await get(revoked.store.id, original.view.id)).id).toBe(original.view.id); expect(f.provider.counts()).toEqual(noIo);
      await f.provider.assertEncryptedFiles([resolve(revoked.node.keys.directory, "execution.pe"), resolve(revoked.node.keys.directory, "state.pe")]);
      expect(worker.evidence.leaked).toBe(false);
      proof.push({ case: "revoked_store_authorization_after_refresh_submit", executionId: original.view.id, credentialDeletedBeforeResponse: true,
        generationChanged: true, lateCredentialNotRestored: true, originalReceiptReadable: true, actualRefreshCalls: 1, laterShopRequests: 0 });
    } finally { gate.release.release(); await worker.close(); }
  });

  it("keeps a submitted refresh with no response unknown across real CLI restart and forbids old-token reuse or central fallback", async () => {
    const s = await scene(); f.provider.controls.fault = "lose"; f.provider.controls.faultKind = "etsy_refresh";
    const done = await finish(s); expect(done.result.state).toBe("unknown_outcome");
    const node = (await f.rows(s.node.nodeId)).node!;
    const readJournal = async () => { const bytes = await readFile(resolve(s.node.keys.directory, "execution.pe"));
      try { const journal = z.object({ version: z.literal(1), completed: z.boolean(), lease: StoreNodeExecutionLeaseSchema }).parse(
        await openStoreNodeJournal(bytes, s.node.keys.passphrase, node.publicKeySpkiSha256));
        return { completed: journal.completed, leaseSha256: nodeExecutionSha(JSON.stringify(journal.lease)), executionId: journal.lease.id,
          requestId: journal.lease.requestId, requestChecksum: journal.lease.requestChecksum, claimId: journal.lease.claimId,
          nodeId: journal.lease.nodeId, accountId: journal.lease.accountId, credentialId: journal.lease.credentialId, credentialVersion: journal.lease.credentialVersion };
      } finally { bytes.fill(0); }
    };
    // The original completion ACK must actually be saved before this completed-journal restart.
    await expect.poll(async () => (await readJournal()).completed, { timeout: 15_000 }).toBe(true);
    await done.child.close(); const originalJournal = await readJournal(), first = f.provider.counts();
    const pending = await f.accountRows(s.store.id); expect(pending.account?.credentialRefreshState).toBe("unknown"); expect(pending.snapshots).toHaveLength(0);
    const originalRow = pending.executions.find(value => value.id === done.view.id);
    expect(originalJournal).toMatchObject({ completed: true, executionId: done.view.id, requestId: done.request.requestId, requestChecksum: done.request.requestChecksum,
      claimId: originalRow?.claim_id, nodeId: s.node.nodeId, accountId: s.store.id, credentialId: pending.credential!.id, credentialVersion: 1 });
    f.provider.controls.fault = "none"; const restarted = await f.workNode(s.node.keys);
    try { const original = await f.executions.receipt(await f.current(), s.store.id, { requestId: done.request.requestId, requestChecksum: done.request.requestChecksum });
      expect(original.execution?.id).toBe(done.view.id); expect(original.execution?.state).toBe("unknown_outcome");
      await executionBounded(restarted.done, "store_node_unknown_restart_exit_deadline", 15_000);
      expect(restarted.evidence.exited).toBe(true); expect(restarted.evidence.exitCode).toBe(1); expect(restarted.evidence.signal).toBeNull();
      expect(restarted.evidence.stderrCode).toBe("store_node_reissue_required"); expect(restarted.evidence.forced).toBe(false); expect(restarted.evidence.leaked).toBe(false);
      expect(restarted.evidence.storageDiagnostic).toBeNull(); expect(restarted.evidence.states.map(value => value.state)).toEqual(["stopped"]);
      expect(await readJournal()).toEqual(originalJournal);
      await expect(f.capabilities.sync(await f.current(), s.store.id, done.request.input)).rejects.toMatchObject({ status: 409 });
      expect(f.provider.counts()).toEqual(first); expect((await get(s.store.id, done.view.id)).state).toBe("unknown_outcome");
      proof.push({ case: "unknown_refresh_restart", executionId: done.view.id, actualRefreshCalls: 1, platformReposts: 0, centralFallback: false,
        journalCompleted: true, originalLeaseSha256: originalJournal.leaseSha256, restartCode: restarted.evidence.stderrCode, restartExited: restarted.evidence.exited });
    } finally { await restarted.close(); }
  });

  it("recovers a lost real checkpoint ACK using its exact persisted ciphertext and original receipt before continuing", async () => {
    const s = await scene(), before = f.provider.counts(), done = await finish(s, {}, { loss: "checkpoint" });
    expect(done.result.state).toBe("succeeded"); const loss = JSON.parse(await readFile(done.child.lossMarker, "utf8")) as unknown;
    expect(loss).toEqual({ rpc: "checkpoint", status: 200, explicitSyntheticLoss: true });
    const rows = await f.accountRows(s.store.id); expect(rows.credential?.version).toBe(2); expect(rows.snapshots).toHaveLength(1);
    expect((f.provider.counts().etsy_refresh ?? 0) - (before.etsy_refresh ?? 0)).toBe(1);
    const request = await f.http(rootPath(s.store.id) + "/receipt", { requestId: done.request.requestId, requestChecksum: done.request.requestChecksum }); expect(request.status).toBe(200);
    expect(StoreNodeExecutionReceiptSchema.parse(request.body).execution?.snapshotId).toBe(done.result.snapshotId);
    proof.push({ case: "checkpoint_ack_loss", executionId: done.result.id, fixtureInjectedTransportLoss: true, realRefreshes: 1, credentialVersion: 2 });
  });

  it("fails closed while offline or draining and requires independent node-local Etsy app configuration without central inheritance", async () => {
    const s = await scene(), before = f.provider.counts(); await f.expire(s.node.nodeId, "session"); await f.expire(s.node.nodeId, "binding");
    const waiting = await f.submit(s.store.id); expect(waiting.view.state).toBe("waiting_node"); expect(f.provider.counts()).toEqual(before);
    await expect(f.capabilities.sync(await f.current(), s.store.id, waiting.request.input)).rejects.toMatchObject({ status: 409 });
    const missing = await f.workNode(s.node.keys, { etsy: "missing" });
    try { await expect.poll(async () => (await get(s.store.id, waiting.view.id)).state, { timeout: 20_000 }).toBe("failed");
      expect((await get(s.store.id, waiting.view.id)).errorCode).toBe("store_node_configuration_invalid"); expect(f.provider.counts()).toEqual(before);
      const standbyKeys = await f.initNode(), standby = await f.enrollNode(s.store.id, standbyKeys), pulse = await f.runNode(standbyKeys);
      try { await expect.poll(async () => (await f.rows(standby.created.enrollment.nodeId)).node?.lastSequence, { timeout: 15_000 }).toBeGreaterThan(0);
        const current = StoreNodeWorkspaceSchema.parse(await f.service.workspace(await f.current(), s.store.id));
        const drained = StoreNodeWorkspaceSchema.parse(await f.service.bind(await f.current(), s.store.id, { nodeId: standby.created.enrollment.nodeId,
          expectedAuthorizationGeneration: current.authorizationGeneration, expectedBindingRevision: current.binding.revision,
          expectedCertificateGeneration: standby.created.enrollment.certificateGeneration })); expect(drained.binding.state).toBe("draining");
      } finally { await pulse.close(); }
      const view = StoreNodeExecutionWorkspaceSchema.parse(await f.executions.workspace(await f.current(), s.store.id)); expect(view.configuration.reason).toBe("draining"); expect(view.access.canSubmit).toBe(false);
      expect((await f.http(rootPath(s.store.id), { ...waiting.request, requestId: createEntityId() })).status).toBe(409);
      proof.push({ case: "offline_and_local_configuration", executionId: waiting.view.id, platformCalls: 0, centralConfigurationNotInherited: true, drainBlocksNew: true });
    } finally { await missing.close(); }
  });

  it("rejects untrusted schema URLs secret-bearing results rate limits timeouts and oversized responses with safe original receipts", async () => {
    const beforeWrites = await zeroWrites(), outcomes: object[] = []; let lastAccountId = "";
    for (const [fault, kind, state, expected] of [["rate_limited", "etsy_shop", "failed", "store_node_upstream_rate_limited"],
      ["upstream", "etsy_shop", "failed", "store_node_upstream_retryable"], ["secret", "etsy_taxonomy", "failed", "store_node_secret_output_rejected"],
      ["oversized", "etsy_taxonomy", "unknown_outcome", "store_node_operation_unknown"], ["timeout", "etsy_shop", "unknown_outcome", "store_node_operation_unknown"]] as const) {
      const s = await scene(); lastAccountId = s.store.id; f.provider.controls.fault = fault; f.provider.controls.faultKind = kind;
      const done = await finish(s); expect(done.result.state).toBe(state); expect(done.result.errorCode).toBe(expected); expect(done.result.snapshot).toBeNull();
      const publicValue = JSON.stringify(done.result); for (const needle of f.provider.secretValues) expect(publicValue.includes(needle)).toBe(false);
      expect(done.child.evidence.leaked).toBe(false); expect((await f.accountRows(s.store.id)).snapshots).toHaveLength(0); await done.child.close();
      outcomes.push({ fault, executionId: done.result.id, state: done.result.state, safeCode: done.result.errorCode }); f.provider.controls.fault = "none"; f.provider.controls.faultKind = null;
    }
    expect(await zeroWrites()).toEqual(beforeWrites);
    const s = await scene("amazon"); f.provider.controls.schemaOutsideDefinition = true; const blocked = await finish(s, { amazonProductTypes: ["PILLOW"] });
    expect(blocked.result.state).toBe("failed"); expect(blocked.result.errorCode).toBe("store_node_policy_rejected");
    proof.push({ case: "bounded_platform_boundary", outcomes, noSecretOutput: true, untrustedSchemaUrlRejected: true, extraBusinessWrites: 0 });
    const history = StoreNodeExecutionHistorySchema.parse(await f.executions.history(await f.current(), lastAccountId)); expect(history.items).toHaveLength(1);
    expect(STORE_NODE_PROTOCOL).toBe("erp-store-node-v1");
  }, 180_000);
});
