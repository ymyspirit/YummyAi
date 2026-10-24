import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { StoreNodeEnrollmentCreatedSchema, StoreNodeEnrollmentResultSchema, StoreNodeHeartbeatViewSchema, StoreNodeWorkspaceSchema, STORE_NODE_PROTOCOL,
  type StoreNodeHeartbeatInput, type StoreNodeWorkspace } from "@yummyai/contracts/marketplace/store-node";
import { auditEvents, connectDatabase, memberships, marketplaceStoreNodes, withTenant } from "@yummyai/database";
import { requireStoreNodeIdentityEnvironment } from "../../../../tools/testing/require-store-node-identity-environment.mjs";
import { authorityBounded } from "../../../../tools/testing/marketplace-authority-legacy-upgrade.mjs";
import { nodeIdentityPermissions, storeNodeIdentityFixture, storeNodeSignedEnrollment, nodeIdentitySha, type NodeActor } from "./store-node-identity.test-fixture.js";

const isolated = requireStoreNodeIdentityEnvironment(), database = connectDatabase(isolated.url), f = storeNodeIdentityFixture(database);
const proof: object[] = [];
const heartbeat = (nodeId: string, certificateGeneration = 1, sessionId = createEntityId(), sequence = 1): StoreNodeHeartbeatInput =>
  ({ protocol: STORE_NODE_PROTOCOL, nodeId, certificateGeneration, sessionId, sequence });
const fence = (view: StoreNodeWorkspace, nodeId: string) => ({ expectedAuthorizationGeneration: view.authorizationGeneration,
  expectedBindingRevision: view.binding.revision, expectedCertificateGeneration: view.nodes.find(row => row.id === nodeId)!.certificateGeneration });
async function workspace(accountId: string, who = f.a) {
  const response = await f.http(`/v1/marketplace-accounts/${accountId}/nodes`, undefined, who); expect(response.status).toBe(200);
  const view = StoreNodeWorkspaceSchema.parse(response.body); expect(view.context.actorId).toBe(who.userId); expect(view.context.tenantId).toBe(who.tenantId);
  expect(view.execution).toEqual({ status: "not_integrated", supportsPlatformOperations: false }); return view;
}
async function newNode(accountId: string, who = f.a) { const keys = await f.initNode(); return { keys, ...await f.enrollNode(accountId, keys, who) }; }
async function createTicket(accountId: string, who = f.a) {
  const keys = await f.initNode(), view = await workspace(accountId, who);
  const input = { expectedAuthorizationGeneration: view.authorizationGeneration, expectedBindingRevision: view.binding.revision,
    label: "Synthetic ticket " + keys.id, publicKeyPem: keys.publicKeyPem, idempotencyKey: nodeIdentitySha("ticket:" + keys.id) };
  const actual = await f.http(`/v1/marketplace-accounts/${accountId}/nodes/enrollments`, input, who); expect(actual.status).toBe(201);
  const created = StoreNodeEnrollmentCreatedSchema.parse(actual.body);
  return { keys, input, created, body: storeNodeSignedEnrollment(created.enrollment, await readFile(resolve(keys.directory, "private-key.pem")), keys.passphrase) };
}
async function member(who: NodeActor, status: "active" | "disabled") {
  await withTenant(database.db, who.ceiling, tx => tx.update(memberships).set({ status }).where(eq(memberships.id, who.membershipId)));
}
async function totals() {
  return withTenant(database.db, f.a.ceiling, async tx => { const [row] = await tx.execute<{ paid: number; publications: number; syncs: number }>(sql`select
    (select count(*)::int from ai_budget_ledger) as paid,(select count(*)::int from marketplace_publication_requests) as publications,
    (select count(*)::int from marketplace_listing_sync_requests) as syncs`); return row; });
}
beforeAll(() => f.initialize());
afterEach(async () => { for (const who of [f.a, f.peer, f.foreign]) { await member(who, "active"); await f.rights(who); } });
afterAll(async () => {
  const errors: unknown[] = []; try { await f.close(); } catch (error) { errors.push(error); }
  try { await writeFile(resolve("D:/YummyAI/tmp/store-node-identity-20261022-c7e3a6d2/qa", isolated.nonce + "-current-proof.json"),
    JSON.stringify({ operation: "c7e3a6d2", cases: proof, cleanup: f.evidence, originalPlatformExecution: "not_integrated", cleanupFailureCount: errors.length })); }
  catch (error) { errors.push(error); }
  try { await database.client.end(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Store node identity teardown failed");
});

describe("real personal OIDC, OpenSSL certificates and store-node mTLS identity", () => {
  it("runs the actual CLI init/enroll/run against original Nest and socket certificate identity without any platform execution", async () => {
    const account = await f.createStore(), before = await totals(), node = await newNode(account.id), provider = { ...f.provider.counts };
    const session = await f.http("/v1/identity/session"); expect(session.status).toBe(200);
    expect(ErpSessionViewSchema.parse(session.body).userId).toBe(f.a.userId);
    const child = await f.runNode(node.keys);
    try {
      await expect.poll(async () => (await f.rows(node.created.enrollment.nodeId)).node?.lastSequence ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
      const view = await workspace(account.id), row = view.nodes.find(value => value.id === node.created.enrollment.nodeId)!;
      expect(row.status).toBe("enrolled"); expect(row.reachability).toBe("online"); expect(row.ticketState).toBe("consumed");
      const certificate = new X509Certificate(node.socket.cert);
      expect(certificate.keyUsage).toEqual(["1.3.6.1.5.5.7.3.2"]); expect(certificate.subjectAltName).toBe(`URI:urn:yummyai:store-node:${row.id}`);
      expect(nodeIdentitySha(certificate.raw)).toBe(row.certificateFingerprintSha256);
      const binding = await f.http(`/v1/marketplace-accounts/${account.id}/nodes/binding`, { ...fence(view, row.id), nodeId: row.id });
      expect(binding.status).toBe(200); expect(StoreNodeWorkspaceSchema.parse(binding.body).binding.nodeId).toBe(row.id);
      expect((await workspace(account.id)).binding.effective).toBe(true);
      const events = await withTenant(database.db, f.a.ceiling, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.entityId, row.id), eq(auditEvents.tenantId, f.a.tenantId))));
      expect(events.map(event => event.action)).toEqual(expect.arrayContaining(["store_node.create", "store_node.enroll", "store_node.bind"]));
      const serialized = JSON.stringify(view); expect(serialized.includes(node.created.enrollment.ticketToken)).toBe(false); expect(serialized.includes("PRIVATE KEY")).toBe(false);
      expect(await totals()).toEqual(before); expect(f.provider.counts).toEqual(provider);
      proof.push({ case: "actual_cli_and_original_auth", accountId: account.id, nodeId: row.id, genuineOidcMember: f.a.userId, certificateFingerprint: row.certificateFingerprintSha256,
        bootstrapPosts: f.evidence.bootstrapPosts, paidAndBusinessUnchanged: true, execution: "not_integrated", standardCli: true });
    } finally { await child.close(); }
    expect(child.evidence.leaked).toBe(false); expect(child.evidence.environmentKeys.some(name => /DATABASE|S3_|OIDC_|TOKEN/.test(name))).toBe(false);
  });

  it("binds single-use enrollment to the real RSA key, rejects expiry and strict foreign tenant input, and never replays a secret ticket", async () => {
    const account = await f.createStore(), ticket = await createTicket(account.id), other = await f.initNode();
    async function rejectsInvalidRow(change: Partial<typeof marketplaceStoreNodes.$inferInsert>) {
      let rejected: unknown;
      try { await withTenant(database.db, f.a.ceiling, tx => tx.update(marketplaceStoreNodes).set(change).where(eq(marketplaceStoreNodes.id, ticket.body.nodeId))); }
      catch (error) { rejected = error; }
      const codes: string[] = []; let error = rejected;
      for (let depth = 0; error && typeof error === "object" && depth < 5; depth++) {
        if ("code" in error && typeof error.code === "string") codes.push(error.code);
        error = "cause" in error ? error.cause : undefined;
      }
      expect(codes).toContain("23514");
    }
    const intact = (await f.rows(ticket.body.nodeId)).node!;
    await rejectsInvalidRow({ ticketDigest: null });
    await rejectsInvalidRow({ certificatePem: "SYNTHETIC_INVALID_RESIDUAL_CERTIFICATE" });
    expect((await f.rows(ticket.body.nodeId)).node).toEqual(intact);
    const badSignature = { ...ticket.body, signature: (ticket.body.signature[0] === "A" ? "B" : "A") + ticket.body.signature.slice(1) };
    expect((await f.tls("/v1/store-nodes/enroll", badSignature)).status).toBe(401);
    const wrongKey = storeNodeSignedEnrollment(ticket.created.enrollment, await readFile(resolve(other.directory, "private-key.pem")), other.passphrase);
    expect((await f.tls("/v1/store-nodes/enroll", wrongKey)).status).toBe(409);
    expect((await f.rows(ticket.body.nodeId)).node?.ticketState).toBe("issued");
    expect((await f.tls("/v1/store-nodes/enroll", { ...ticket.body, tenantId: f.foreign.tenantId })).status).toBe(400);
    expect((await f.http(`/v1/marketplace-accounts/${account.id}/nodes/enrollments`, ticket.input)).status).toBe(409);
    expect((await f.http(`/v1/marketplace-accounts/${account.id}/nodes/enrollments`, { ...ticket.input, label: ticket.input.label + " different" })).status).toBe(409);
    const accepted = await f.tls("/v1/store-nodes/enroll", ticket.body);
    const safeCode = accepted.body && typeof accepted.body === "object" && "code" in accepted.body && typeof accepted.body.code === "string" && /^store_node_[a-z_]{1,100}$/.test(accepted.body.code) ? accepted.body.code : null;
    expect(accepted.status, JSON.stringify({ status: accepted.status, code: safeCode })).toBe(201);
    const certificate = new X509Certificate(StoreNodeEnrollmentResultSchema.parse(accepted.body).certificatePem), adopted = (await f.rows(ticket.body.nodeId)).node!;
    const claimAt = adopted.certificateIssuedAt!.getTime(), notBefore = new Date(certificate.validFrom).getTime(), notAfter = new Date(certificate.validTo).getTime();
    expect(notBefore).toBe(Math.floor((claimAt - 30_000) / 1000) * 1000); expect(notAfter - notBefore).toBe(24 * 3600_000);
    expect((await f.tls("/v1/store-nodes/enroll", ticket.body)).status).toBe(401);
    const expired = await createTicket(account.id); await f.expire(expired.body.nodeId, "ticket");
    expect((await f.tls("/v1/store-nodes/enroll", expired.body)).status).toBe(401); expect((await f.rows(expired.body.nodeId)).node?.certificatePem).toBeNull();
    proof.push({ case: "rsa_ticket_once_expiry", nodeId: ticket.body.nodeId, expiredNodeId: expired.body.nodeId,
      databaseChecks: ["issued_ticket_requires_digest", "pending_node_rejects_residual_certificate"],
      expiryMethod: "root-authorized exact owned ticket expiresAt moved before actual database clock; original request guards unchanged" });
  });

  it("rejects absent or untrusted peer certificates, forged identity headers and real cross-store or cross-tenant access", async () => {
    const account = await f.createStore(), otherStore = await f.createStore(), node = await newNode(account.id), other = await newNode(otherStore.id);
    const input = heartbeat(node.created.enrollment.nodeId);
    await expect(f.tls("/v1/store-nodes/runtime/heartbeat", input)).rejects.toThrow();
    await expect(f.tls("/v1/store-nodes/runtime/heartbeat", input, { ...node.socket, ca: f.foreignCa })).rejects.toThrow();
    await expect(f.tls("/v1/store-nodes/runtime/heartbeat", input, {}, { "x-store-node-id": input.nodeId, "x-ssl-client-verify": "SUCCESS" })).rejects.toThrow();
    const mismatch = await f.tls("/v1/store-nodes/runtime/heartbeat", input, other.socket); expect(mismatch.status).toBe(400);
    expect((await f.rows(input.nodeId)).node?.lastSequence).toBe(0);
    expect((await f.http(`/v1/marketplace-accounts/${account.id}/nodes`, undefined, f.foreign)).status).toBe(404);
    await f.rights(f.peer, nodeIdentityPermissions, "self");
    expect((await f.http(`/v1/marketplace-accounts/${account.id}/nodes`, undefined, f.peer)).status).toBe(403);
    const accepted = await f.tls("/v1/store-nodes/runtime/heartbeat", input, node.socket); expect(accepted.status).toBe(200);
    const view = StoreNodeHeartbeatViewSchema.parse(accepted.body); expect(view.accountId).toBe(account.id); expect(view.execution).toBe("not_integrated");
    proof.push({ case: "actual_tls_and_scope", nodeId: input.nodeId, noCertRejected: true, wrongTrustRejected: true, otherStoreCertRejected: true, foreignTenantRejected: true, selfPeerRejected: true });
  });

  it("uses one database CAS across service instances and drains the old real lease before standby takeover or old receipt recovery", async () => {
    const account = await f.createStore(), a = await newNode(account.id), b = await newNode(account.id);
    const first = heartbeat(a.created.enrollment.nodeId), second = heartbeat(b.created.enrollment.nodeId);
    expect((await f.tls("/v1/store-nodes/runtime/heartbeat", first, a.socket)).status).toBe(200);
    expect((await f.tls("/v1/store-nodes/runtime/heartbeat", second, b.socket)).status).toBe(200);
    const initial = await workspace(account.id);
    const attempts = await Promise.allSettled([f.service.bind(await f.current(), account.id, { ...fence(initial, first.nodeId), nodeId: first.nodeId }),
      f.http(`/v1/marketplace-accounts/${account.id}/nodes/binding`, { ...fence(initial, second.nodeId), nodeId: second.nodeId })]);
    const success = attempts.filter(value => value.status === "fulfilled" && (!('status' in value.value) || value.value.status === 200)); expect(success).toHaveLength(1);
    const active = await workspace(account.id), aWins = active.binding.nodeId === first.nodeId, original = aWins ? a : b;
    const originalInput = aWins ? first : second, standbyInput = aWins ? second : first;
    const activeReceipt = await f.tls("/v1/store-nodes/runtime/heartbeat", { ...originalInput, sequence: 2 }, original.socket); expect(activeReceipt.status).toBe(200);
    const before = await workspace(account.id), lease = before.binding.leaseExpiresAt;
    const drained = await f.http(`/v1/marketplace-accounts/${account.id}/nodes/binding`, { ...fence(before, standbyInput.nodeId), nodeId: standbyInput.nodeId });
    expect(drained.status).toBe(200); const draining = StoreNodeWorkspaceSchema.parse(drained.body);
    expect(draining.binding.state).toBe("draining"); expect(draining.binding.nodeId).toBe(originalInput.nodeId); expect(draining.binding.leaseExpiresAt).toBe(lease);
    const stillOld = await f.service.bind(await f.current(), account.id, { ...fence(draining, standbyInput.nodeId), nodeId: standbyInput.nodeId });
    expect(stillOld.binding.nodeId).toBe(originalInput.nodeId); expect(stillOld.binding.state).toBe("draining");
    await f.expire(originalInput.nodeId, "binding"); const expired = await workspace(account.id);
    const takeover = await f.http(`/v1/marketplace-accounts/${account.id}/nodes/binding`, { ...fence(expired, standbyInput.nodeId), nodeId: standbyInput.nodeId });
    expect(takeover.status).toBe(200); const current = StoreNodeWorkspaceSchema.parse(takeover.body);
    expect(current.binding.nodeId).toBe(standbyInput.nodeId); expect(current.binding.effective).toBe(true);
    expect((await f.tls("/v1/store-nodes/runtime/heartbeat", { ...originalInput, sequence: 2 }, original.socket)).status).toBe(409);
    proof.push({ case: "cas_and_drained_takeover", accountId: account.id, original: originalInput.nodeId, standby: standbyInput.nodeId,
      expiryMethod: "only exact fixture binding leaseExpiresAt changed under original tenant RLS; no global fake clock", oldActiveReceiptRejected: true });
  });

  it("refuses late real issuer output and a pre-authenticated TLS body after current member authority is withdrawn", async () => {
    const account = await f.createStore(), ticket = await createTicket(account.id), gate = f.issuerGate();
    const pending = gate.service.enroll(ticket.body); void pending.catch(() => {});
    try {
      await authorityBounded(Promise.race([gate.entered, pending.then(() => { throw new Error("store_node_issuer_settled_early"); })]), "store_node_real_issuer_gate_deadline");
      const before = await workspace(account.id);
      const revoked = await f.http(`/v1/marketplace-accounts/${account.id}/nodes/${ticket.body.nodeId}/revoke`, fence(before, ticket.body.nodeId)); expect(revoked.status).toBe(200);
      gate.release(); await expect(pending).rejects.toMatchObject({ status: 409 });
      const original = await f.rows(ticket.body.nodeId); expect(original.node?.status).toBe("revoked"); expect(original.node?.certificatePem).toBeNull();
    } finally { gate.release(); await pending.catch(() => {}); }
    const node = await newNode(account.id), input = heartbeat(node.created.enrollment.nodeId), held = await f.heldHeartbeat(input, node.socket);
    try {
      await f.rights(f.a, [Permission.StoreRead, Permission.StoreManage]); held.release(); const denied = await held.result; expect(denied.status).toBe(403);
      expect((await f.rows(input.nodeId)).node?.lastSequence).toBe(0);
    } finally { held.release(); await held.result.catch(() => {}); await f.rights(f.a); }
    await member(f.a, "disabled"); expect((await f.http(`/v1/marketplace-accounts/${account.id}/nodes`)).status).toBe(403);
    expect((await f.tls("/v1/store-nodes/runtime/heartbeat", input, node.socket)).status).toBe(403); await member(f.a, "active");
    proof.push({ case: "late_and_current_membership", issuerNodeId: ticket.body.nodeId, lateSocketNodeId: input.nodeId, actualTlsHandshakeBeforeLoss: true,
      realIssuerResultDiscarded: true, membershipRevocationCheckedOnRequest: true });
  });

  it("invalidates old certificate generations on reissue, revoke, store disable and authorization generation changes", async () => {
    const account = await f.createStore(), node = await newNode(account.id), input = heartbeat(node.created.enrollment.nodeId);
    expect((await f.tls("/v1/store-nodes/runtime/heartbeat", input, node.socket)).status).toBe(200);
    const old = await workspace(account.id), reissue = await f.http(`/v1/marketplace-accounts/${account.id}/nodes/${input.nodeId}/enrollment`, fence(old, input.nodeId));
    expect(reissue.status).toBe(201); const renewed = StoreNodeEnrollmentCreatedSchema.parse(reissue.body);
    expect(renewed.enrollment.certificateGeneration).toBe(2); expect((await f.tls("/v1/store-nodes/runtime/heartbeat", { ...input, sequence: 2 }, node.socket)).status).toBe(401);
    const signed = storeNodeSignedEnrollment(renewed.enrollment, await readFile(resolve(node.keys.directory, "private-key.pem")), node.keys.passphrase);
    expect((await f.tls("/v1/store-nodes/enroll", signed)).status).toBe(201);
    const next = await f.rows(input.nodeId), socket = { ...node.socket, cert: next.node!.certificatePem! }, fresh = heartbeat(input.nodeId, 2);
    expect((await f.tls("/v1/store-nodes/runtime/heartbeat", fresh, socket)).status).toBe(200);
    await f.accounts.update(await f.current(), account.id, { enabled: false });
    expect((await f.tls("/v1/store-nodes/runtime/heartbeat", { ...fresh, sequence: 2 }, socket)).status).toBe(409);
    await f.accounts.update(await f.current(), account.id, { enabled: true });
    expect((await f.tls("/v1/store-nodes/runtime/heartbeat", { ...fresh, sequence: 2 }, socket)).status).toBe(409);
    const otherStore = await f.createStore(), other = await newNode(otherStore.id), otherInput = heartbeat(other.created.enrollment.nodeId);
    expect((await f.tls("/v1/store-nodes/runtime/heartbeat", otherInput, other.socket)).status).toBe(200);
    await f.authorization.revoke(await f.current(), otherStore.id);
    expect((await f.tls("/v1/store-nodes/runtime/heartbeat", { ...otherInput, sequence: 2 }, other.socket)).status).toBe(409);
    proof.push({ case: "immutable_generation_fences", nodeId: input.nodeId, certificateGeneration: 2, oldCertRejected: true, disableAndReenableDoesNotRestoreOldAuthority: true });
  });

  it("recovers a genuinely lost TLS heartbeat response in the actual CLI with the original session and sequence without extending its receipt lease", async () => {
    const account = await f.createStore(), node = await newNode(account.id), provider = { ...f.provider.counts }, child = await f.runNode(node.keys, true);
    try {
      await expect.poll(() => child.evidence.states.some(value => value.state === "offline"), { timeout: 15_000 }).toBe(true);
      const adopted = (await f.rows(node.created.enrollment.nodeId)).node!; expect(adopted.lastSequence).toBe(1); expect(adopted.lastHeartbeatResponse).not.toBeNull();
      await expect.poll(() => child.evidence.states.some(value => value.state === "online" && value.sequence === 1), { timeout: 15_000 }).toBe(true); await child.close();
      const recovered = (await f.rows(adopted.id)).node!; expect(recovered.lastSequence).toBe(1); expect(recovered.sessionId).toBe(adopted.sessionId);
      expect(recovered.lastHeartbeatResponse).toEqual(adopted.lastHeartbeatResponse); expect(recovered.sessionExpiresAt).toEqual(adopted.sessionExpiresAt); expect(recovered.lastSeenAt).toEqual(adopted.lastSeenAt);
      const receipt = StoreNodeHeartbeatViewSchema.parse(recovered.lastHeartbeatResponse);
      expect((await f.tls("/v1/store-nodes/runtime/heartbeat", { ...heartbeat(receipt.nodeId, receipt.certificateGeneration, receipt.sessionId, receipt.sequence), sequence: 3 }, node.socket)).status).toBe(409);
      expect((await f.tls("/v1/store-nodes/runtime/heartbeat", heartbeat(receipt.nodeId, receipt.certificateGeneration), node.socket)).status).toBe(409);
      expect(f.provider.counts).toEqual(provider); expect(child.evidence.leaked).toBe(false);
      proof.push({ case: "actual_cli_explicit_response_loss", nodeId: adopted.id, sessionId: adopted.sessionId, originalSequence: 1,
        injection: "test-only preload destroys the first real TLS200 Response after original callback; no request/certificate/body/result modified", originalLeaseUnchanged: true });
    } finally { await child.close(); }
  });

  it("keeps offline state explicit, restarts the real encrypted local identity and makes workspace recovery read only", async () => {
    const account = await f.createStore(), node = await newNode(account.id), before = await totals(), provider = { ...f.provider.counts };
    let child = await f.runNode(node.keys);
    try {
      await expect.poll(() => child.evidence.states.some(value => value.state === "online"), { timeout: 15_000 }).toBe(true); await child.close();
      const first = (await f.rows(node.created.enrollment.nodeId)).node!, beforeRead = JSON.stringify(first);
      await workspace(account.id); await workspace(account.id); expect(JSON.stringify((await f.rows(first.id)).node)).toBe(beforeRead);
      await f.expire(first.id, "session"); const offline = await workspace(account.id); expect(offline.nodes.find(value => value.id === first.id)?.reachability).toBe("offline");
      expect(offline.binding.effective).toBe(false); expect(offline.execution.supportsPlatformOperations).toBe(false);
      const cipher = await readFile(resolve(node.keys.directory, "state.pe")); expect(cipher.includes(Buffer.from(node.created.enrollment.ticketToken))).toBe(false);
      const privateKey = await readFile(resolve(node.keys.directory, "private-key.pem"), "utf8"); expect(privateKey.startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----")).toBe(true);
      const posts = f.evidence.bootstrapPosts; child = await f.runNode(node.keys);
      await expect.poll(() => child.evidence.states.some(value => value.state === "online"), { timeout: 15_000 }).toBe(true); await child.close();
      const last = (await f.rows(first.id)).node!; expect(last.sessionId).toBe(first.sessionId); expect(last.lastSequence).toBeGreaterThan(first.lastSequence);
      expect(f.evidence.bootstrapPosts).toBe(posts); expect(await totals()).toEqual(before); expect(f.provider.counts).toEqual(provider);
      proof.push({ case: "real_stop_restart_readonly", nodeId: first.id, sameSession: true, extraEnrollmentPosts: 0, encryptedState: true, noCentralFallbackOrPlatformOperation: true,
        expiryMethod: "exact fixture node session expiry moved under tenant RLS; not a natural30second duration claim" });
    } finally { await child.close(); }
  });
});
