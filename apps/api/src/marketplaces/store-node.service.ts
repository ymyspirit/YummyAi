import { createHash, createPublicKey, randomBytes, verify, X509Certificate } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { authorize, erpPermissionContext, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { TenantContextSchema } from "@yummyai/contracts/tenant/tenant-context";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { BindStoreNodeInputSchema, CreateStoreNodeEnrollmentInputSchema, StoreNodeEnrollInputSchema,
  StoreNodeEnrollmentCreatedSchema, StoreNodeEnrollmentResultSchema, StoreNodeGenerationFenceSchema,
  StoreNodeHeartbeatInputSchema, StoreNodeHeartbeatViewSchema, StoreNodeWorkspaceSchema, STORE_NODE_PROTOCOL,
  type BindStoreNodeInput, type CreateStoreNodeEnrollmentInput, type StoreNodeEnrollInput,
  type StoreNodeGenerationFence, type StoreNodeHeartbeatInput, type StoreNodeMutationFence,
  type StoreNodeWorkspace } from "@yummyai/contracts/marketplace/store-node";
import { marketplaceAccounts, marketplaceStoreNodes as nodes, marketplaceStoreNodeBindings as bindings, memberships,
  withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, asc, eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { assertMarketplaceGeneration, currentMarketplaceAuthority, databaseNow, lockMarketplaceAccount, type MarketplaceAccountRow } from "./marketplace-authority.js";
import { StoreNodeCertificateIssuer, storeNodeCertificateValidity, storeNodeEnrollmentProof, type StoreNodePeer } from "./store-node.types.js";

type NodeRow = typeof nodes.$inferSelect;
type BindingRow = typeof bindings.$inferSelect;
const TICKET_MS = 10 * 60_000, SESSION_MS = 30_000;
const digest = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
const fail = (code: string): never => { throw new ConflictException({ code, message: "节点状态已变化 请读取当前状态后继续" }); };

@Injectable()
export class StoreNodeService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StoreNodeCertificateIssuer) private readonly issuer: StoreNodeCertificateIssuer) {}

  async workspace(context: TenantContext, accountId: string): Promise<StoreNodeWorkspace> {
    return withTenant(this.database.db, context, async tx => {
      const { account, authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreRead);
      return this.view(tx, authority, account);
    });
  }

  async createEnrollment(context: TenantContext, accountId: string, raw: CreateStoreNodeEnrollmentInput) {
    const input = CreateStoreNodeEnrollmentInputSchema.parse(raw), key = publicKey(input.publicKeyPem);
    this.requireConfigured();
    return withTenant(this.database.db, context, async tx => {
      const { account, authority, binding, now } = await this.locked(tx, context, accountId, input);
      const inputDigest = digest(JSON.stringify([accountId, input.label, key.pem, input.expectedAuthorizationGeneration, input.expectedBindingRevision]));
      const [prior] = await tx.select().from(nodes).where(eq(nodes.creationRequestKey, input.idempotencyKey));
      if (prior) fail(prior.creationInputDigest === inputDigest ? "store_node_ticket_not_replayable" : "store_node_idempotency_conflict");
      const existing = await tx.select({ id: nodes.id, key: nodes.publicKeySpkiSha256 }).from(nodes).where(eq(nodes.accountId, accountId));
      if (existing.length >= 100) fail("store_node_limit");
      if (existing.some(n => n.key === key.sha256)) fail("store_node_key_exists");
      const id = createEntityId(), ticketToken = `stn_${id}.${randomBytes(32).toString("base64url")}`;
      const [node] = await tx.insert(nodes).values({ id, tenantId: authority.tenantId, accountId, label: input.label,
        publicKeyPem: key.pem, publicKeySpkiSha256: key.sha256, creationRequestKey: input.idempotencyKey, creationInputDigest: inputDigest,
        authorizationGeneration: account.authorizationGeneration, createdBy: authority.userId,
        membershipId: await this.memberId(tx, authority), authorityCeiling: authority,
        ticketDigest: digest(ticketToken), ticketState: "issued", ticketExpiresAt: new Date(now.getTime() + TICKET_MS), createdAt: now, updatedAt: now }).returning();
      await this.event(tx, authority, node!, "create", binding.revision);
      return StoreNodeEnrollmentCreatedSchema.parse({ workspace: await this.view(tx, authority, account), enrollment: this.bundle(node!, ticketToken) });
    });
  }

  async reissueEnrollment(context: TenantContext, accountId: string, nodeId: string, raw: StoreNodeGenerationFence) {
    const input = StoreNodeGenerationFenceSchema.parse(raw); this.requireConfigured();
    return withTenant(this.database.db, context, async tx => {
      const { account, authority, binding, now } = await this.locked(tx, context, accountId, input);
      const node = await this.node(tx, accountId, nodeId); this.certificateFence(node, input);
      const ticketToken = `stn_${nodeId}.${randomBytes(32).toString("base64url")}`;
      await this.drain(tx, binding, node, now);
      const [updated] = await tx.update(nodes).set({ ...this.clearCertificate(), status: "pending_enrollment", certificateGeneration: node.certificateGeneration + 1,
        authorizationGeneration: account.authorizationGeneration, authorityCeiling: authority, membershipId: await this.memberId(tx, authority),
        ticketDigest: digest(ticketToken), ticketState: "issued", ticketExpiresAt: new Date(now.getTime() + TICKET_MS),
        enrollmentClaimId: null, revokedAt: null, updatedAt: now }).where(eq(nodes.id, nodeId)).returning();
      await this.event(tx, authority, updated!, "reissue", binding.revision);
      return StoreNodeEnrollmentCreatedSchema.parse({ workspace: await this.view(tx, authority, account), enrollment: this.bundle(updated!, ticketToken) });
    });
  }

  async revoke(context: TenantContext, accountId: string, nodeId: string, raw: StoreNodeGenerationFence) {
    const input = StoreNodeGenerationFenceSchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      const { account, authority, binding, now } = await this.locked(tx, context, accountId, input, false);
      const node = await this.node(tx, accountId, nodeId); this.certificateFence(node, input);
      await this.drain(tx, binding, node, now);
      const [updated] = await tx.update(nodes).set({ ...this.clearCertificate(), status: "revoked", certificateGeneration: node.certificateGeneration + 1,
        ticketDigest: null, ticketState: "none", ticketExpiresAt: null, enrollmentClaimId: null, revokedAt: now, updatedAt: now })
        .where(eq(nodes.id, nodeId)).returning();
      await this.event(tx, authority, updated!, "revoke", binding.revision);
      return this.view(tx, authority, account);
    });
  }

  async bind(context: TenantContext, accountId: string, raw: BindStoreNodeInput) {
    const input = BindStoreNodeInputSchema.parse(raw); this.requireConfigured();
    return withTenant(this.database.db, context, async tx => {
      const { account, authority, binding, now } = await this.locked(tx, context, accountId, input);
      const node = await this.node(tx, accountId, input.nodeId); this.certificateFence(node, input);
      await this.origin(tx, node, account);
      if (node.status !== "enrolled" || !node.certificateExpiresAt || node.certificateExpiresAt <= now ||
        !node.sessionExpiresAt || node.sessionExpiresAt <= now || node.authorizationGeneration !== account.authorizationGeneration) fail("store_node_not_ready");
      const same = binding.state === "active" && binding.nodeId === node.id && binding.certificateGeneration === node.certificateGeneration &&
        binding.authorizationGeneration === account.authorizationGeneration;
      if (same) return this.view(tx, authority, account);
      if (binding.leaseExpiresAt && binding.leaseExpiresAt > now) {
        if (binding.state !== "draining") {
          await tx.update(bindings).set({ state: "draining", revision: binding.revision + 1, updatedAt: now }).where(eq(bindings.id, binding.id));
          await this.event(tx, authority, node, "drain", binding.revision + 1);
        }
        return this.view(tx, authority, account);
      }
      await tx.update(bindings).set({ state: "active", nodeId: node.id, certificateGeneration: node.certificateGeneration,
        authorizationGeneration: account.authorizationGeneration, revision: binding.revision + 1,
        leaseExpiresAt: node.sessionExpiresAt, approvedBy: authority.userId, membershipId: await this.memberId(tx, authority), authorityCeiling: authority, updatedAt: now })
        .where(eq(bindings.id, binding.id));
      await this.event(tx, authority, node, "bind", binding.revision + 1);
      return this.view(tx, authority, account);
    });
  }

  async enroll(raw: StoreNodeEnrollInput) {
    const input = StoreNodeEnrollInputSchema.parse(raw); this.requireConfigured();
    const key = publicKey(input.publicKeyPem), ticketDigest = digest(input.ticketToken);
    if (!input.ticketToken.startsWith(`stn_${input.nodeId}.`) || !verify("sha256", storeNodeEnrollmentProof(input.nodeId, ticketDigest, key.sha256), key.pem, Buffer.from(input.signature, "base64url")))
      throw new UnauthorizedException({ code: "store_node_proof_invalid" });
    const origin = await this.resolve(sql`select * from authenticate_store_node_ticket(${input.nodeId}::uuid,${ticketDigest})`);
    const claim = await withTenant(this.database.db, origin.context, async tx => {
      const { account, authority } = await lockMarketplaceAccount(tx, origin.context, origin.accountId, Permission.StoreManage);
      this.active(account); await this.ensureBinding(tx, account);
      const node = await this.node(tx, account.id, input.nodeId); await this.origin(tx, node, account);
      const now = await databaseNow(tx);
      if (node.status !== "pending_enrollment" || node.ticketState !== "issued" || node.ticketDigest !== ticketDigest ||
        !node.ticketExpiresAt || node.ticketExpiresAt <= now || node.publicKeySpkiSha256 !== key.sha256 || node.publicKeyPem !== key.pem) fail("store_node_ticket_unavailable");
      const claimId = createEntityId();
      await tx.update(nodes).set({ ticketState: "claimed", enrollmentClaimId: claimId, updatedAt: now }).where(eq(nodes.id, node.id));
      await this.event(tx, authority, node, "enrollment_claim", 0);
      return { node, claimId, issuedAt: now };
    });
    // Signing occurs outside the owner transaction. A late certificate is unusable
    // until the exact original claim and current authority adopt its fingerprint.
    const issued = StoreNodeEnrollmentResultSchema.parse(await this.issuer.issue({ nodeId: claim.node.id, accountId: claim.node.accountId,
      publicKeyPem: claim.node.publicKeyPem, certificateGeneration: claim.node.certificateGeneration, issuedAt: claim.issuedAt }));
    const certificate = this.validateCertificate(issued, claim.node, claim.issuedAt);
    return withTenant(this.database.db, origin.context, async tx => {
      const { account, authority } = await lockMarketplaceAccount(tx, origin.context, origin.accountId, Permission.StoreManage);
      this.active(account); await this.ensureBinding(tx, account);
      const node = await this.node(tx, account.id, input.nodeId); await this.origin(tx, node, account);
      const now = await databaseNow(tx);
      if (certificate.startsAt > now) fail("store_node_certificate_not_yet_valid");
      if (node.status !== "pending_enrollment" || node.certificateGeneration !== claim.node.certificateGeneration || node.enrollmentClaimId !== claim.claimId ||
        node.ticketState !== "claimed" || node.ticketDigest !== ticketDigest || !node.ticketExpiresAt || node.ticketExpiresAt <= now || certificate.expiresAt <= now) fail("store_node_enrollment_changed");
      const [updated] = await tx.update(nodes).set({ status: "enrolled", ticketState: "consumed", certificatePem: issued.certificatePem,
        certificateFingerprintSha256: certificate.fingerprint, certificateExpiresAt: certificate.expiresAt, certificateIssuedAt: claim.issuedAt, updatedAt: now })
        .where(eq(nodes.id, node.id)).returning();
      await this.event(tx, authority, updated!, "enroll", 0);
      return issued;
    });
  }

  async runtimeHeartbeat(peer: StoreNodePeer, raw: StoreNodeHeartbeatInput) {
    const input = StoreNodeHeartbeatInputSchema.parse(raw); this.requireConfigured();
    const actual = new X509Certificate(peer.certificatePem);
    if (digest(actual.raw) !== peer.fingerprintSha256 || digest(actual.publicKey.export({ type: "spki", format: "der" })) !== peer.publicKeySpkiSha256)
      throw new UnauthorizedException({ code: "store_node_peer_invalid" });
    const resolved = await this.resolve(sql`select * from authenticate_store_node_peer(${peer.fingerprintSha256})`);
    if (resolved.nodeId !== input.nodeId) throw new UnauthorizedException({ code: "store_node_peer_mismatch" });
    return withTenant(this.database.db, resolved.context, async tx => {
      const { account } = await lockMarketplaceAccount(tx, resolved.context, resolved.accountId, Permission.StoreManage);
      this.active(account, true);
      const binding = await this.ensureBinding(tx, account), node = await this.node(tx, account.id, input.nodeId);
      await this.origin(tx, node, account);
      const now = await databaseNow(tx);
      if (node.status !== "enrolled" || node.certificateGeneration !== input.certificateGeneration || node.certificateFingerprintSha256 !== peer.fingerprintSha256 ||
        node.publicKeySpkiSha256 !== peer.publicKeySpkiSha256 || !node.certificateExpiresAt || node.certificateExpiresAt <= now) fail("store_node_certificate_changed");
      const selected = binding.nodeId === node.id;
      let approved = false;
      if (selected && binding.authorityCeiling && binding.membershipId) approved = await this.bindingApproval(tx, binding, account);
      if (node.sessionId === input.sessionId && node.lastSequence === input.sequence && node.lastHeartbeatResponse) {
        // Unknown response recovery returns the original result, without extending
        // its lease, but never after the store, certificate or approval changed.
        if (node.lastHeartbeatResponse.bindingRevision !== binding.revision || selected && !approved) fail("store_node_binding_changed");
        return StoreNodeHeartbeatViewSchema.parse(node.lastHeartbeatResponse);
      }
      if (node.sessionId === input.sessionId) {
        if (input.sequence !== node.lastSequence + 1) fail("store_node_sequence_changed");
      } else if (input.sequence !== 1 || (node.sessionExpiresAt && node.sessionExpiresAt > now)) fail("store_node_session_busy");
      const sessionExpiresAt = new Date(Math.min(now.getTime() + SESSION_MS, node.certificateExpiresAt!.getTime()));
      const current = selected && approved && binding.state === "active" && binding.certificateGeneration === node.certificateGeneration && binding.authorizationGeneration === account.authorizationGeneration;
      if (current) await tx.update(bindings).set({ leaseExpiresAt: sessionExpiresAt, updatedAt: now }).where(eq(bindings.id, binding.id));
      const result = StoreNodeHeartbeatViewSchema.parse({ protocol: STORE_NODE_PROTOCOL, nodeId: node.id, accountId: account.id,
        certificateGeneration: node.certificateGeneration, sessionId: input.sessionId, sequence: input.sequence, observedAt: now.toISOString(), sessionExpiresAt: sessionExpiresAt.toISOString(),
        bindingRevision: binding.revision, bindingState: selected && binding.state === "draining" ? "draining" : current ? "active" : "unbound",
        authorizationGeneration: account.authorizationGeneration, execution: "not_integrated" });
      await tx.update(nodes).set({ sessionId: input.sessionId, lastSequence: input.sequence, sessionExpiresAt, lastSeenAt: now, lastHeartbeatResponse: result, updatedAt: now }).where(eq(nodes.id, node.id));
      return result;
    });
  }

  private async locked(tx: TenantTransaction, context: TenantContext, accountId: string, input: StoreNodeMutationFence, requireActive = true) {
    const { account, authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreManage);
    authorize(authority, Permission.StoreRead, { ownerId: account.createdBy });
    authorize(authority, Permission.StoreAuthorize, { ownerId: account.createdBy });
    assertMarketplaceGeneration(account, input.expectedAuthorizationGeneration); if (requireActive) this.active(account);
    const binding = await this.ensureBinding(tx, account);
    if (binding.revision !== input.expectedBindingRevision) fail("store_node_binding_changed");
    return { account, authority, binding, now: await databaseNow(tx) };
  }
  private active(account: MarketplaceAccountRow, allowPendingRefresh = false) {
    if (account.deletedAt) fail("store_node_store_inactive");
    if (account.status === "active") return;
    // A freshly authorized shop must be able to establish identity before its
    // first capability snapshot. This never grants publication or another tool.
    if (["pending_authorization", "degraded"].includes(account.status) && ["valid", "expiring"].includes(account.credentialStatus)
      && (account.credentialRefreshState === "known" || allowPendingRefresh && account.credentialRefreshState === "pending")) return;
    fail("store_node_store_inactive");
  }

  /** Same identity owner, with a separate checkpoint-only physical trust gate. */
  async runtimeAccess<T>(peer: StoreNodePeer, input: { nodeId: string; certificateGeneration: number; sessionId: string },
    current: boolean, callback: (tx: TenantTransaction, value: { account: MarketplaceAccountRow; node: NodeRow; binding: BindingRow; now: Date }) => Promise<T>): Promise<T> {
    this.requireConfigured();
    const actual = new X509Certificate(peer.certificatePem);
    if (digest(actual.raw) !== peer.fingerprintSha256 || digest(actual.publicKey.export({ type: "spki", format: "der" })) !== peer.publicKeySpkiSha256
      || actual.subjectAltName !== `URI:urn:yummyai:store-node:${input.nodeId}`) throw new UnauthorizedException({ code: "store_node_peer_invalid" });
    const resolved = await this.resolve(sql`select * from authenticate_store_node_peer(${peer.fingerprintSha256})`);
    if (resolved.nodeId !== input.nodeId) throw new UnauthorizedException({ code: "store_node_peer_mismatch" });
    return withTenant(this.database.db, resolved.context, async tx => {
      const account = current ? (await lockMarketplaceAccount(tx, resolved.context, resolved.accountId, Permission.StoreManage)).account
        : (await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, resolved.accountId)).for("update").limit(1))[0];
      if (!account || account.deletedAt || ["disabled", "revoked"].includes(account.status)) fail("store_node_store_inactive");
      const binding = await this.ensureBinding(tx, account), node = await this.node(tx, account.id, input.nodeId), now = await databaseNow(tx);
      if (node.status !== "enrolled" || node.certificateGeneration !== input.certificateGeneration || node.certificateFingerprintSha256 !== peer.fingerprintSha256
        || node.publicKeySpkiSha256 !== peer.publicKeySpkiSha256 || !node.certificateExpiresAt || node.certificateExpiresAt <= now
        || node.authorizationGeneration !== account.authorizationGeneration) fail("store_node_certificate_changed");
      if (current) {
        this.active(account, true); await this.origin(tx, node, account);
        if (node.sessionId !== input.sessionId || !node.sessionExpiresAt || node.sessionExpiresAt <= now) fail("store_node_session_busy");
        const selected = await this.executionBinding(tx, account, true);
        if (selected.node.id !== node.id) fail("store_node_binding_changed");
      }
      return callback(tx, { account, node, binding, now });
    });
  }

  async executionBinding(tx: TenantTransaction, account: MarketplaceAccountRow, requireOnline: boolean) {
    this.active(account, true);
    const [binding] = await tx.select().from(bindings).where(eq(bindings.accountId, account.id)).for("update");
    if (!binding || binding.state !== "active" || !binding.nodeId || binding.authorizationGeneration !== account.authorizationGeneration) fail("store_node_binding_changed");
    const node = await this.node(tx, account.id, binding.nodeId!), now = await databaseNow(tx);
    await this.origin(tx, node, account);
    if (!(await this.bindingApproval(tx, binding, account)) || node.status !== "enrolled" || binding.certificateGeneration !== node.certificateGeneration
      || !node.certificateExpiresAt || node.certificateExpiresAt <= now) fail("store_node_binding_changed");
    const online = Boolean(binding.leaseExpiresAt && binding.leaseExpiresAt > now && node.sessionExpiresAt && node.sessionExpiresAt > now);
    if (requireOnline && !online) fail("store_node_not_ready");
    return { binding, node, now, online };
  }
  private requireConfigured() { if (!this.issuer.configuration().enabled) throw new ServiceUnavailableException({ code: "store_node_not_configured" }); }
  private async ensureBinding(tx: TenantTransaction, account: MarketplaceAccountRow): Promise<BindingRow> {
    const [existing] = await tx.select().from(bindings).where(eq(bindings.accountId, account.id)).for("update");
    if (existing) return existing;
    const [created] = await tx.insert(bindings).values({ id: createEntityId(), tenantId: account.tenantId, accountId: account.id }).returning();
    return created!;
  }
  private async node(tx: TenantTransaction, accountId: string, nodeId: string): Promise<NodeRow> {
    const [node] = await tx.select().from(nodes).where(and(eq(nodes.id, nodeId), eq(nodes.accountId, accountId))).for("update");
    if (!node) throw new NotFoundException({ code: "store_node_not_found" }); return node;
  }
  private certificateFence(node: NodeRow, input: StoreNodeGenerationFence) { if (node.certificateGeneration !== input.expectedCertificateGeneration) fail("store_node_certificate_changed"); }
  private async memberId(tx: TenantTransaction, context: TenantContext) {
    const [member] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, context.userId), eq(memberships.status, "active"))).for("share");
    if (!member) throw new UnauthorizedException({ code: "store_node_membership_changed" }); return member.id;
  }
  private async origin(tx: TenantTransaction, node: NodeRow, account: MarketplaceAccountRow) {
    const ceiling = TenantContextSchema.parse(node.authorityCeiling);
    if (ceiling.tenantId !== node.tenantId || node.accountId !== account.id || node.authorizationGeneration !== account.authorizationGeneration) fail("store_node_authority_changed");
    const current = await currentMarketplaceAuthority(tx, ceiling, Permission.StoreManage, account);
    authorize(current, Permission.StoreRead, { ownerId: account.createdBy });
    authorize(current, Permission.StoreAuthorize, { ownerId: account.createdBy });
    if (await this.memberId(tx, current) !== node.membershipId) fail("store_node_membership_changed");
    return current;
  }
  private async bindingApproval(tx: TenantTransaction, binding: BindingRow, account: MarketplaceAccountRow) {
    const ceiling = binding.authorityCeiling;
    if (!ceiling || ceiling.tenantId !== account.tenantId || binding.authorizationGeneration !== account.authorizationGeneration) return false;
    const authority = await currentMarketplaceAuthority(tx, ceiling, Permission.StoreManage, account);
    authorize(authority, Permission.StoreRead, { ownerId: account.createdBy });
    authorize(authority, Permission.StoreAuthorize, { ownerId: account.createdBy });
    return await this.memberId(tx, authority) === binding.membershipId;
  }
  private async drain(tx: TenantTransaction, binding: BindingRow, node: NodeRow, now: Date) {
    if (binding.nodeId !== node.id) return;
    // Preserve the old deadline even after revocation. No heartbeat can extend a
    // draining binding; an immediately revoked cert is not proof of drained work.
    await tx.update(bindings).set({ state: "draining", revision: binding.revision + 1, updatedAt: now }).where(eq(bindings.id, binding.id));
  }
  private clearCertificate() {
    return { certificateFingerprintSha256: null, certificatePem: null, certificateExpiresAt: null, certificateIssuedAt: null,
      sessionId: null, lastSequence: 0, sessionExpiresAt: null, lastSeenAt: null, lastHeartbeatResponse: null };
  }
  private bundle(node: NodeRow, ticketToken: string) {
    const configuration = this.issuer.configuration();
    return { protocol: STORE_NODE_PROTOCOL, nodeId: node.id, accountId: node.accountId, certificateGeneration: node.certificateGeneration,
      ticketToken, publicKeySpkiSha256: node.publicKeySpkiSha256, enrollmentOrigin: configuration.enrollmentOrigin,
      runtimeOrigin: configuration.runtimeOrigin, caCertificatePem: this.issuer.caCertificatePem(), expiresAt: node.ticketExpiresAt!.toISOString() };
  }
  private validateCertificate(result: ReturnType<typeof StoreNodeEnrollmentResultSchema.parse>, node: NodeRow, issuedAt: Date) {
    const certificate = new X509Certificate(result.certificatePem), ca = new X509Certificate(this.issuer.caCertificatePem());
    const expiresAt = new Date(certificate.validTo), startsAt = new Date(certificate.validFrom);
    const expected = storeNodeCertificateValidity(issuedAt);
    if (result.nodeId !== node.id || result.accountId !== node.accountId || result.certificateGeneration !== node.certificateGeneration ||
      result.caCertificatePem !== this.issuer.caCertificatePem() || result.runtimeOrigin !== this.issuer.configuration().runtimeOrigin || certificate.ca ||
      digest(certificate.publicKey.export({ type: "spki", format: "der" })) !== node.publicKeySpkiSha256 || !certificate.verify(ca.publicKey) ||
      certificate.subjectAltName !== `URI:urn:yummyai:store-node:${node.id}` || startsAt.getTime() !== expected.startsAt.getTime() || expiresAt.getTime() !== expected.expiresAt.getTime() ||
      !certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.2") || expiresAt <= issuedAt || expiresAt.getTime() - startsAt.getTime() > 24 * 3600_000 ||
      expiresAt.toISOString() !== result.expiresAt) throw new ServiceUnavailableException({ code: "store_node_certificate_invalid" });
    return { fingerprint: digest(certificate.raw), startsAt, expiresAt };
  }
  private async resolve(query: Parameters<TenantTransaction["execute"]>[0]) {
    const rows = await this.database.db.transaction(async tx => {
      await tx.execute(sql.raw("set local role yummyai_app")); return tx.execute(query);
    });
    const row = rows[0];
    if (!row || typeof row.account_id !== "string") throw new UnauthorizedException({ code: "store_node_identity_unavailable" });
    return { accountId: row.account_id, nodeId: row.node_id, context: TenantContextSchema.parse(row.authority_ceiling) };
  }
  private async view(tx: TenantTransaction, authority: TenantContext, account: MarketplaceAccountRow): Promise<StoreNodeWorkspace> {
    const now = await databaseNow(tx), [binding] = await tx.select().from(bindings).where(eq(bindings.accountId, account.id));
    const records = await tx.select().from(nodes).where(eq(nodes.accountId, account.id)).orderBy(asc(nodes.createdAt), asc(nodes.id)).limit(101);
    if (records.length > 100) fail("store_node_limit");
    const can = (permission: Permission) => { try { authorize(authority, permission, { ownerId: account.createdBy }); return true; } catch { return false; } };
    let effective = false;
    const bound = records.find(n => n.id === binding?.nodeId);
    if (binding && bound && account.status === "active" && binding.state === "active" && binding.authorizationGeneration === account.authorizationGeneration &&
      bound.status === "enrolled" && binding.certificateGeneration === bound.certificateGeneration && bound.authorizationGeneration === account.authorizationGeneration &&
      binding.leaseExpiresAt && binding.leaseExpiresAt > now && bound.sessionExpiresAt && bound.sessionExpiresAt > now && bound.certificateExpiresAt && bound.certificateExpiresAt > now) {
      try { await this.origin(tx, bound, account); effective = await this.bindingApproval(tx, binding, account); } catch (error) {
        if (!(error instanceof Error) || !["ForbiddenError", "UnauthorizedException", "ConflictException"].includes(error.constructor.name)) throw error;
      }
    }
    return StoreNodeWorkspaceSchema.parse({ protocol: STORE_NODE_PROTOCOL, accountId: account.id, authorizationGeneration: account.authorizationGeneration,
      context: { actorId: authority.userId, tenantId: authority.tenantId, authority: digest(erpSessionAuthority(erpPermissionContext(authority))) },
      binding: { revision: binding?.revision ?? 0, state: binding?.state ?? "unbound", nodeId: binding?.nodeId ?? null,
        authorizationGeneration: binding?.authorizationGeneration ?? null, leaseExpiresAt: binding?.leaseExpiresAt?.toISOString() ?? null, effective },
      nodes: records.map(node => ({ id: node.id, label: node.label, status: node.status, certificateGeneration: node.certificateGeneration,
        certificateExpiresAt: node.certificateExpiresAt?.toISOString() ?? null, certificateFingerprintSha256: node.certificateFingerprintSha256,
        publicKeySpkiSha256: node.publicKeySpkiSha256, lastSeenAt: node.lastSeenAt?.toISOString() ?? null, sessionExpiresAt: node.sessionExpiresAt?.toISOString() ?? null,
        reachability: !node.lastSeenAt ? "never_seen" : node.status === "enrolled" && node.sessionExpiresAt && node.sessionExpiresAt > now && node.certificateExpiresAt && node.certificateExpiresAt > now ? "online" : "offline",
        ticketState: node.ticketState === "issued" && node.ticketExpiresAt && node.ticketExpiresAt <= now ? "expired" : node.ticketState,
        ticketExpiresAt: node.ticketExpiresAt?.toISOString() ?? null, creationRequestKey: node.creationRequestKey, createdAt: node.createdAt.toISOString() })),
      access: { manage: can(Permission.StoreManage), authorize: can(Permission.StoreAuthorize) }, configuration: this.issuer.configuration(),
      execution: { status: "not_integrated", supportsPlatformOperations: false }, observedAt: now.toISOString() });
  }
  private event(tx: TenantTransaction, context: TenantContext, node: NodeRow, action: string, bindingRevision: number) {
    return this.audit.recordInTransaction(tx, context, { action: `store_node.${action}`, resourceType: "store_node", resourceId: node.id, result: "success",
      metadata: { accountId: node.accountId, certificateGeneration: node.certificateGeneration, bindingRevision, publicKeySpkiSha256: node.publicKeySpkiSha256 } });
  }
}

function publicKey(pem: string) {
  try {
    const key = createPublicKey(pem), bits = key.asymmetricKeyDetails?.modulusLength;
    const canonical = key.export({ type: "spki", format: "pem" }).toString();
    if (key.asymmetricKeyType !== "rsa" || !bits || bits < 3072 || bits > 4096 || canonical !== pem) throw new Error("invalid key");
    return { pem: canonical, sha256: digest(key.export({ type: "spki", format: "der" })) };
  } catch { throw new BadRequestException({ code: "store_node_public_key_invalid", message: "需要节点生成的 RSA 3072 至 4096 位 SPKI 公钥" }); }
}
