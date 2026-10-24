import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { PublicationPreviewReceiptSchema, PublicationPreviewRequestViewSchema, STORE_NODE_PUBLICATION_OPERATION,
  publicationPreviewPayloadText } from "@yummyai/contracts/marketplace/publication-preview";
import { StoreNodeExecutionLeaseSchema, StoreNodeExecutionViewSchema } from "@yummyai/contracts/marketplace/store-node-execution";
import { connectDatabase, marketplaceCredentials, withTenant } from "@yummyai/database";
import { openStoreNodeSealedCredential } from "@yummyai/marketplace-connectors";
import { requireAmazonPublicNodeEnvironment } from "../../../../tools/testing/amazon-public-node-environment.mjs";
import { openStoreNodeJournal } from "../../../store-api-node/src/identity.js";
import { publicationNodePreviewFixture, nodeExecutionSha, safeCode, executionCleanupDiagnostic, type ExecutionNodeKeys } from "./publication-node-preview.test-fixture.js";

const isolated = requireAmazonPublicNodeEnvironment(), database = connectDatabase(isolated.url),
  f = publicationNodePreviewFixture(database, { amazonPublic: true }), proof: object[] = [];
const path = "/v1/marketplace-publications/preview";
const capabilityClasses = ["amazon_lwa", "amazon_participations", "amazon_product_definition", "amazon_schema", "amazon_meta_schema"] as const;
async function journal(keys: ExecutionNodeKeys) {
  const bytes = await readFile(resolve(keys.directory, "execution.pe"));
  try { return z.object({ completed: z.boolean(), lease: StoreNodeExecutionLeaseSchema, rows: z.array(z.object({ ordinal: z.int(), requestClass: z.string(),
    state: z.string(), stepAcknowledged: z.boolean() }).passthrough()), completion: z.object({ payloadChecksum: z.string() }).passthrough().nullable() }).passthrough()
    .parse(await openStoreNodeJournal(bytes, keys.passphrase, nodeExecutionSha(createPublicKey(keys.publicKeyPem).export({ type: "spki", format: "der" }))));
  } finally { bytes.fill(0); }
}
async function paidOrPublished() {
  return withTenant(database.db, f.a.ceiling, async tx => (await tx.execute<{ paid: number; published: number; listingSyncs: number }>(sql`select
    (select count(*)::int from ai_budget_ledger) paid,
    (select count(*)::int from marketplace_publication_requests where action<>'amazon_validation_preview') published,
    (select count(*)::int from marketplace_listing_sync_requests) "listingSyncs"`))[0]!);
}
function noSecrets(value: unknown) { const json = JSON.stringify(value); for (const secret of f.provider.secretValues) expect(json.includes(secret)).toBe(false); }
async function preview(storeId: string, keys: ExecutionNodeKeys, loss?: "complete") {
  const source = await f.seedListing(storeId), input = await f.previewInput(source), created = await f.http(path, input);
  expect(created.status, JSON.stringify({ status: created.status, code: safeCode(created.body) })).toBe(201);
  const view = PublicationPreviewRequestViewSchema.parse(created.body), before = f.provider.counts(), child = await f.workNode(keys, { loss }),
    result = await f.waitPreview(view.request.id, child);
  expect(result.request.current.status, JSON.stringify({ state: result.execution?.state, code: result.execution?.errorCode })).toBe("validation_passed");
  expect(result.execution?.state).toBe("succeeded"); expect(result.access.canContinue).toBe(false);
  expect((f.provider.counts().amazon_lwa ?? 0) - (before.amazon_lwa ?? 0)).toBe(1);
  expect((f.provider.counts().amazon_listing_validation_preview ?? 0) - (before.amazon_listing_validation_preview ?? 0)).toBe(1);
  const rows = await f.previewRows(), request = rows.requests.find(row => row.id === view.request.id)!;
  expect(request.payloadChecksum).toBe(nodeExecutionSha(publicationPreviewPayloadText({ platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US",
    productType: "HOME", sku: source.sku, attributes: source.attributes })));
  const steps = rows.steps.filter(row => row.executionId === view.execution!.id).sort((a, b) => a.ordinal - b.ordinal);
  expect(steps.map(row => [row.ordinal, row.requestClass, row.outcome, row.httpStatus])).toEqual([[1, "amazon_lwa", "received", 200], [2, "amazon_listing_validation_preview", "received", 200]]);
  noSecrets(result); return { source, input, view, result, child };
}
async function capability(storeId: string, keys: ExecutionNodeKeys, options: Parameters<typeof f.workNode>[1] = {}) {
  const submitted = await f.submit(storeId, { amazonProductTypes: ["HOME"] }), child = await f.workNode(keys, options),
    result = await f.waitExecution(storeId, submitted.view.id, child);
  return { ...submitted, child, result };
}
beforeAll(() => f.initialize());
afterEach(async () => { f.provider.controls.fault = "none"; f.provider.controls.faultKind = null; await f.stopChildren(); });
afterAll(async () => {
  const errors: unknown[] = [], diagnostics: ReturnType<typeof executionCleanupDiagnostic> = [];
  for (const [phase, close] of [["fixture", () => f.close()], ["database", () => database.client.end()]] as const)
    try { await close(); } catch (error) { errors.push(error); diagnostics.push(...executionCleanupDiagnostic(error, phase)); }
  await writeFile(resolve(isolated.lane, isolated.nonce + "-current-proof.json"), JSON.stringify({ operation: "3d7f9a21", cases: proof, cleanup: f.evidence,
    cleanupFailureCount: errors.length, diagnostics, providerBoundary: "synthetic_tls_after_original_policy", actualPlatform: false, actualPublication: false }));
  if (errors.length) throw new AggregateError(errors, "amazon_public_node_cleanup_failed");
});

describe("Amazon public OAuth through the original owner and actual node CLI", () => {
  it("public_oauth_cli_capability_preview uses central code exchange and distinct node-local refresh for the original capability and preview", async () => {
    const before = f.provider.records.length, untouched = await paidOrPublished(), s = await f.bootstrapStore();
    expect(s.store.authorizationMode).toBe("amazon_public");
    const original = await f.accountRows(s.store.id); expect(original.account?.status).toBe("active"); expect(original.snapshots).toHaveLength(1);
    expect(original.snapshots[0]!.capabilities).toContain("listing_write");
    const initial = f.provider.records.slice(before); expect(initial.filter(row => !row.node).map(row => [row.kind, row.status, row.application]))
      .toEqual([["amazon_oauth", 200, "central"]]);
    expect(initial.filter(row => row.node).map(row => row.kind).sort()).toEqual([...capabilityClasses].sort());
    expect(initial.filter(row => row.kind === "amazon_lwa")).toMatchObject([{ node: true, status: 200, application: "node", credentialAccepted: true }]);
    const local = await journal(s.node.keys), key = createPrivateKey({ key: await readFile(resolve(s.node.keys.directory, "private-key.pem")), passphrase: s.node.keys.passphrase }),
      opened = openStoreNodeSealedCredential(local.lease.sealedCredential, local.lease, key);
    try {
      expect(opened.payload.amazonAppClientIdSha256).toBe(nodeExecutionSha(f.provider.clientId));
      expect(opened.payload.credential).toMatchObject({ kind: "amazon_public", clientId: f.provider.clientId });
      expect(Object.hasOwn(opened.payload.credential, "clientSecret")).toBe(false);
      expect(JSON.stringify(opened.payload)).not.toContain(f.provider.secrets.centralApp); expect(JSON.stringify(opened.payload)).not.toContain(f.provider.secrets.nodeApp);
      const bypass = await f.provider.request("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: f.provider.clientId, client_secret: f.provider.secrets.centralApp, refresh_token: opened.payload.credential.refreshToken! }) });
      expect(bypass.status).toBe(401); await bypass.body?.cancel();
    } finally { opened.key.fill(0); }
    const done = await preview(s.store.id, s.node.keys); await done.child.close();
    const events = await f.http(`/v1/marketplace-publications/${done.view.request.id}/events`); expect(events.status).toBe(200); noSecrets(events.body);
    expect(await paidOrPublished()).toEqual(untouched);
    const files = ["execution.pe", "state.pe", "private-key.pem"].map(file => resolve(s.node.keys.directory, file)); await f.provider.assertEncryptedFiles(files);
    proof.push({ case: "public_oauth_cli_capability_preview", accountId: s.store.id, requestId: done.view.request.id, publicApplicationPinned: true,
      centralExchange: 1, capabilityHttp: 5, previewHttp: 2, centralRefreshBypassRejected: true, noApplicationSecretInSeed: true, sourceUnitMinor: 12345, currency: "USD", zeroPaidOrPublication: true });
  });

  it("public_local_application_missing_or_wrong_zero_io rejects both exact configuration defects before any provider request", async () => {
    for (const configuration of ["missing", "wrong"] as const) {
      const store = await f.createStore(f.a, "amazon"), node = await f.bindNode(store.id, await f.initNode()), before = f.provider.counts(), original = await f.accountRows(store.id),
        done = await capability(store.id, node.keys, { amazon: configuration });
      expect(done.result.state).toBe("failed"); expect(done.result.errorCode).toBe("store_node_configuration_invalid"); await done.child.close();
      const after = await f.accountRows(store.id); expect(after.snapshots).toHaveLength(0); expect(after.credential).toEqual(original.credential);
      expect(f.provider.counts()).toEqual(before); noSecrets(done.result);
      proof.push({ case: "local_application_zero_io", configuration, accountId: store.id, executionId: done.result.id, code: done.result.errorCode, providerDelta: 0 });
    }
  });

  it("legacy_public_pin_requires_reauthorization does not infer an absent original client ID from current configuration", async () => {
    const store = await f.createStore(f.a, "amazon"), node = await f.bindNode(store.id, await f.initNode()), original = await f.accountRows(store.id), credential = original.credential!;
    const legacy = await f.vault.withSecret(credential.encryptedEnvelope, raw => { const value = z.record(z.string(), z.string()).parse(JSON.parse(raw));
      expect(value.clientId).toBe(f.provider.clientId); delete value.clientId; return f.vault.encrypt(JSON.stringify(value)); });
    // Explicit synthetic legacy absence only. The original grant, generation and token version are retained.
    await withTenant(database.db, f.a.ceiling, tx => tx.update(marketplaceCredentials).set({ encryptedEnvelope: legacy })
      .where(and(eq(marketplaceCredentials.id, credential.id), eq(marketplaceCredentials.version, credential.version))));
    try {
      const before = f.provider.counts(), done = await capability(store.id, node.keys);
      expect(done.result.state).toBe("failed"); expect(done.result.errorCode).toBe("store_node_application_reauthorization_required"); await done.child.close();
      expect(f.provider.counts()).toEqual(before); const after = await f.accountRows(store.id);
      expect(after.account?.authorizationGeneration).toBe(original.account?.authorizationGeneration); expect(after.credential?.version).toBe(credential.version); expect(after.snapshots).toHaveLength(0);
      noSecrets(done.result); proof.push({ case: "legacy_public_pin_requires_reauthorization", executionId: done.result.id, providerDelta: 0, syntheticLegacyMissingClientId: true });
    } finally { await withTenant(database.db, f.a.ceiling, tx => tx.update(marketplaceCredentials).set({ encryptedEnvelope: credential.encryptedEnvelope })
      .where(and(eq(marketplaceCredentials.id, credential.id), eq(marketplaceCredentials.version, credential.version)))); }
  });

  it("changed_public_application_requires_reauthorization preserves the original queued identity instead of adopting today's application", async () => {
    const store = await f.createStore(f.a, "amazon"), node = await f.bindNode(store.id, await f.initNode()), submitted = await f.submit(store.id, { amazonProductTypes: ["HOME"] }),
      before = f.provider.counts(), original = await f.accountRows(store.id), previous = process.env.AMAZON_SPAPI_LWA_CLIENT_ID;
    let child: Awaited<ReturnType<typeof f.workNode>> | undefined;
    try {
      process.env.AMAZON_SPAPI_LWA_CLIENT_ID = "synthetic-current-application-replaced";
      child = await f.workNode(node.keys); const result = await f.waitExecution(store.id, submitted.view.id, child);
      expect(result.state).toBe("failed"); expect(result.errorCode).toBe("store_node_application_reauthorization_required"); await child.close();
      expect(f.provider.counts()).toEqual(before); expect((await f.accountRows(store.id)).credential).toEqual(original.credential);
      proof.push({ case: "changed_public_application_requires_reauthorization", executionId: result.id, originalRequestKey: submitted.request.requestId, providerDelta: 0 });
    } finally { if (previous === undefined) delete process.env.AMAZON_SPAPI_LWA_CLIENT_ID; else process.env.AMAZON_SPAPI_LWA_CLIENT_ID = previous; await child?.close(); }
    const restored = StoreNodeExecutionViewSchema.parse(await f.executions.get(await f.current(), store.id, submitted.view.id));
    expect(restored.id).toBe(submitted.view.id); expect(restored.errorCode).toBe("store_node_application_reauthorization_required"); expect(f.provider.counts()).toEqual(before);
  });

  it("public_lost_ack_restart_no_http_replay recovers the same original receipt without local application configuration or another physical call", async () => {
    const s = await f.bootstrapStore(), done = await preview(s.store.id, s.node.keys, "complete");
    await expect.poll(async () => { try { return JSON.parse(await readFile(done.child.lossMarker, "utf8")) as unknown; } catch { return null; } }, { timeout: 15_000 })
      .toEqual({ rpc: "complete", status: 200, explicitSyntheticLoss: true });
    await done.child.close(); const before = f.provider.counts(), prior = await journal(s.node.keys), rows = await f.previewRows(),
      url = path + "/receipt?" + new URLSearchParams({ requestKey: done.input.requestKey, requestChecksum: done.input.requestChecksum }),
      first = await f.http(url); expect(first.status).toBe(200); const original = PublicationPreviewReceiptSchema.parse(first.body);
    const restarted = await f.workNode(s.node.keys, { amazon: "missing" });
    try {
      await expect.poll(async () => (await journal(s.node.keys)).completed, { timeout: 20_000 }).toBe(true);
      const final = await journal(s.node.keys); expect(final.lease).toEqual(prior.lease); expect(final.lease.operation).toBe(STORE_NODE_PUBLICATION_OPERATION);
      expect(final.rows.map(row => [row.ordinal, row.requestClass, row.stepAcknowledged])).toEqual([[1, "amazon_lwa", true], [2, "amazon_listing_validation_preview", true]]);
      const response = await f.http(url); expect(response.status).toBe(200); expect(PublicationPreviewReceiptSchema.parse(response.body).request).toEqual(original.request);
      expect((await f.previewRows()).events).toEqual(rows.events); expect(f.provider.counts()).toEqual(before); noSecrets(response.body);
      proof.push({ case: "public_lost_ack_restart_no_http_replay", requestId: done.view.request.id, executionId: done.view.execution!.id,
        originalCompletionChecksum: final.completion!.payloadChecksum, restartProviderDelta: 0, localApplicationPresentAtRestart: false });
    } finally { await restarted.close(); expect(restarted.evidence.leaked).toBe(false); }
  });

  it("private_without_public_local_application retains the original private application capability path", async () => {
    const store = await f.createStore(f.a, "amazon", "amazon_private");
    const node = await f.bindNode(store.id, await f.initNode()), before = f.provider.records.length, done = await capability(store.id, node.keys, { amazon: "missing" });
    expect(done.result.state).toBe("succeeded"); expect(done.result.snapshot?.capabilities).toContain("listing_write"); await done.child.close();
    const records = f.provider.records.slice(before); expect(records.map(row => row.kind).sort()).toEqual([...capabilityClasses].sort());
    expect(records.find(row => row.kind === "amazon_lwa")).toMatchObject({ node: true, status: 200, application: "private", credentialAccepted: true });
    const local = await journal(node.keys), key = createPrivateKey({ key: await readFile(resolve(node.keys.directory, "private-key.pem")), passphrase: node.keys.passphrase }),
      seed = openStoreNodeSealedCredential(local.lease.sealedCredential, local.lease, key);
    try { expect(seed.payload.account.authorizationMode).toBe("amazon_private"); expect(seed.payload.amazonAppClientIdSha256).toBeUndefined(); }
    finally { seed.key.fill(0); }
    noSecrets(done.result); expect(await paidOrPublished()).toEqual({ paid: 0, published: 0, listingSyncs: 0 });
    proof.push({ case: "private_without_public_local_application", accountId: store.id, executionId: done.result.id, capabilityHttp: 5, publicLocalApplicationRequired: false });
  });
});
