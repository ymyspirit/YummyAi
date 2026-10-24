import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, erpPermissionContext, Permission } from "@yummyai/authz";
import { createEntityId, MarketplacePlatformSchema, SyncMarketplaceCapabilitiesInputSchema, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import {STORE_NODE_PUBLICATION_OPERATION} from "@yummyai/contracts/marketplace/publication-preview";
import {STORE_NODE_PUBLICATION_SUBMIT_OPERATION,STORE_NODE_PUBLICATION_STATUS_OPERATION} from "@yummyai/contracts/marketplace/publication-submit";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { CancelStoreNodeExecutionInputSchema, CreateStoreNodeExecutionInputSchema, STORE_NODE_EXECUTION_OPERATION, STORE_NODE_EXECUTION_PROTOCOL,
  StoreNodeExecutionAckSchema, StoreNodeExecutionCallSchema, StoreNodeExecutionCheckpointInputSchema, StoreNodeExecutionCheckpointPayloadSchema,
  StoreNodeExecutionClaimInputSchema, StoreNodeExecutionClaimSchema, StoreNodeExecutionCompleteInputSchema, StoreNodeExecutionCompletionPayloadSchema,
  StoreNodeExecutionCredentialSchema, StoreNodeExecutionHistorySchema, StoreNodeExecutionLeaseSchema, StoreNodeExecutionPermitInputSchema,
  StoreNodeExecutionPermitSchema, StoreNodeExecutionReceiptInputSchema, StoreNodeExecutionReceiptSchema, StoreNodeExecutionRuntimeReceiptSchema,
  StoreNodeExecutionStepInputSchema, StoreNodeExecutionSummarySchema, StoreNodeExecutionViewSchema, StoreNodeExecutionWorkspaceSchema,
  storeNodeExecutionRequestText, type CreateStoreNodeExecutionInput, type StoreNodeExecutionCall, type StoreNodeExecutionClaimInput,
  type StoreNodeExecutionPermitInput, type StoreNodeExecutionStepInput, type StoreNodeExecutionCheckpointInput, type StoreNodeExecutionCompleteInput,
  type StoreNodeExecutionReceiptInput, type StoreNodeExecutionSummary, type StoreNodeExecutionRequestClass } from "@yummyai/contracts/marketplace/store-node-execution";
import { marketplaceStoreNodeExecutions as jobs, marketplaceStoreNodeExecutionSteps as steps, marketplaceStoreNodeBindings as bindings,
  marketplaceStoreNodes as nodes, memberships, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { createStoreNodeSealedCredential, marketplaceCapabilityChecksum, MarketplaceConnectorError, openStoreNodeExecutionCredentialSeed, openStoreNodeExecutionPayload,
  storeNodeExecutionPayloadChecksum } from "@yummyai/marketplace-connectors";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, MARKETPLACE_SECRET_VAULT } from "../platform.tokens.js";
import { currentMarketplaceAuthority, databaseNow, lockMarketplaceAccount, type MarketplaceAccountRow } from "./marketplace-authority.js";
import { MarketplaceCredentialUse } from "./marketplace-authority-lease.js";
import { MarketplaceCapabilityService } from "./marketplace-capability.service.js";
import { StoreNodeService } from "./store-node.service.js";
import {MarketplacePublicationService} from "./marketplace-publication.service.js";
import { StoreNodeExecutionRuntime, type StoreNodeExecutionRpc } from "./store-node-execution.types.js";
import type { StoreNodePeer } from "./store-node.types.js";

type Job = typeof jobs.$inferSelect;
type Step = typeof steps.$inferSelect;
const protocol = STORE_NODE_EXECUTION_PROTOCOL;
const active = ["waiting_node", "claimed", "running"] as const;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const credentialSchema = z.record(z.string(), z.string());
function fail(code = "store_node_authority_changed"): never { throw new ConflictException({ code }); }
function parse<T>(schema: z.ZodType<T>, raw: unknown): T { const value = schema.safeParse(raw); if (!value.success) throw new BadRequestException({ code: "store_node_execution_input_invalid" }); return value.data; }

/** Durable orchestration only. Credential rotation and immutable facts retain their original owners. */
@Injectable()
export class StoreNodeExecutionService extends StoreNodeExecutionRuntime {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(MARKETPLACE_SECRET_VAULT) private readonly secrets: SecretVault,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StoreNodeService) private readonly identity: StoreNodeService,
    @Inject(MarketplaceCapabilityService) private readonly capabilities: MarketplaceCapabilityService,
    @Optional() @Inject(MarketplacePublicationService) private readonly publications?:MarketplacePublicationService) { super(); }

  async workspace(context: TenantContext, accountId: string) {
    return withTenant(this.database.db, context, async tx => {
      const { account, authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreRead), now = await databaseNow(tx);
      const [binding] = await tx.select().from(bindings).where(eq(bindings.accountId, accountId)).limit(1);
      const [node] = binding?.nodeId ? await tx.select().from(nodes).where(eq(nodes.id, binding.nodeId)).limit(1) : [];
      const canManage = can(authority, account), supported = supportedMode(account), enabled = this.enabled()
        && (account.platform !== "etsy" || Boolean(process.env.ETSY_APP_KEYSTRING?.trim()))
        && (account.authorizationMode !== "amazon_public" || this.amazonPublicKey() !== null);
      const usable = ["valid", "expiring"].includes(account.credentialStatus) && !["disabled", "revoked"].includes(account.status) && account.credentialRefreshState === "known";
      let eligible = false, invalidAuthority = false;
      if (usable && binding?.state === "active" && binding.nodeId) {
        try { await this.identity.executionBinding(tx, account, false); eligible = true; }
        catch (error) {
          if (!(error instanceof Error) || !["ForbiddenError", "ForbiddenException", "ConflictException", "UnauthorizedException"].includes(error.constructor.name)) throw error;
          invalidAuthority = ["ForbiddenError", "ForbiddenException", "UnauthorizedException"].includes(error.constructor.name);
        }
      }
      const reason = !enabled ? "not_configured" : !supported ? "not_supported" : !canManage ? "not_authorized"
        : !usable ? "credential_unavailable" : binding?.state === "draining" ? "draining" : !eligible ? invalidAuthority ? "not_authorized" : "not_bound" : "ready";
      const recent = await tx.select().from(jobs).where(and(eq(jobs.accountId, accountId),eq(jobs.operation,STORE_NODE_EXECUTION_OPERATION))).orderBy(desc(jobs.id)).limit(20);
      return StoreNodeExecutionWorkspaceSchema.parse({ protocol, accountId, platform: account.platform, authorizationMode: account.authorizationMode,
        accountStatus: account.status, authorizationGeneration: account.authorizationGeneration,
        context: { actorId: authority.userId, tenantId: authority.tenantId, authority: hash(erpSessionAuthority(erpPermissionContext(authority))) },
        binding: { revision: binding?.revision ?? 0, nodeId: binding?.nodeId ?? null, certificateGeneration: binding?.certificateGeneration ?? null,
          state: binding?.state ?? "unbound", online: Boolean(eligible && node?.status === "enrolled" && node.certificateExpiresAt && node.certificateExpiresAt > now
            && node.sessionExpiresAt && node.sessionExpiresAt > now && binding?.leaseExpiresAt && binding.leaseExpiresAt > now
            && binding.authorizationGeneration === account.authorizationGeneration && binding.certificateGeneration === node.certificateGeneration), lastSeenAt: node?.lastSeenAt?.toISOString() ?? null },
        access: { canSubmit: canManage && reason === "ready", canCancel: canManage }, configuration: { enabled, operationSupported: supported, reason },
        operations: supported ? [STORE_NODE_EXECUTION_OPERATION] : [], recent: await Promise.all(recent.map(row => this.summary(tx, row, canManage, now, authority, account))), observedAt: now.toISOString() });
    });
  }

  async create(context: TenantContext, accountId: string, raw: CreateStoreNodeExecutionInput) {
    const input = parse(CreateStoreNodeExecutionInputSchema, raw);
    if (hash(storeNodeExecutionRequestText(accountId, input)) !== input.requestChecksum) fail("store_node_request_changed");
    return withTenant(this.database.db, context, async tx => {
      const { account, authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreManage);
      authorize(authority, Permission.StoreRead, { ownerId: account.createdBy });
      const [existing] = await tx.select().from(jobs).where(and(eq(jobs.accountId, accountId), eq(jobs.requestId, input.requestId))).for("update");
      if (existing) {this.requireCapability(existing); if (existing.requestChecksum !== input.requestChecksum) fail("store_node_request_changed"); return this.view(tx, authority, existing); }
      this.requireEnabled(); if (!supportedMode(account)) fail("store_node_operation_unknown");
      if (account.platform === "etsy") this.etsyPublicKey();
      if (account.authorizationMode === "amazon_public" && !this.amazonPublicKey()) fail("store_node_configuration_invalid");
      if (account.credentialRefreshState !== "known" || !["valid", "expiring"].includes(account.credentialStatus)) fail("store_node_credential_unavailable");
      if (account.platform === "amazon" ? input.input.etsyTaxonomyNodeIds.length > 0 : input.input.amazonProductTypes.length > 0) fail("store_node_policy_rejected");
      const { node, binding, now } = await this.identity.executionBinding(tx, account, false);
      if (input.nodeId !== node.id || input.certificateGeneration !== node.certificateGeneration || input.authorizationGeneration !== account.authorizationGeneration || input.bindingRevision !== binding.revision) fail();
      const [row] = await tx.insert(jobs).values({ id: createEntityId(), tenantId: authority.tenantId, accountId, nodeId: node.id,
        certificateGeneration: node.certificateGeneration, authorizationGeneration: account.authorizationGeneration, bindingRevision: binding.revision,
        requestId: input.requestId, requestChecksum: input.requestChecksum, operation: input.operation, input: input.input,
        createdBy: authority.userId, membershipId: await this.member(tx, authority), authorityCeiling: authority,
        expiresAt: new Date(now.getTime() + 30 * 60_000), createdAt: now, updatedAt: now }).returning();
      await this.event(tx, authority, row!, "create"); return this.view(tx, authority, row!);
    });
  }

  async get(context: TenantContext, accountId: string, executionId: string) {
    return withTenant(this.database.db, context, async tx => {
      const { authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreRead);
      const row=await this.job(tx,accountId,executionId);this.requireCapability(row);return this.view(tx, authority,row);
    });
  }
  async receipt(context: TenantContext, accountId: string, raw: StoreNodeExecutionReceiptInput) {
    const input = parse(StoreNodeExecutionReceiptInputSchema, raw);
    return withTenant(this.database.db, context, async tx => {
      const { authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreRead);
      const [row] = await tx.select().from(jobs).where(and(eq(jobs.accountId, accountId),eq(jobs.operation,STORE_NODE_EXECUTION_OPERATION), eq(jobs.requestId, input.requestId))).limit(1);
      if (row && row.requestChecksum !== input.requestChecksum) fail("store_node_request_changed");
      return StoreNodeExecutionReceiptSchema.parse({ protocol, accountId, ...input, found: Boolean(row), execution: row ? await this.view(tx, authority, row) : null, observedAt: (await databaseNow(tx)).toISOString() });
    });
  }
  async history(context: TenantContext, accountId: string, before?: string) {
    return withTenant(this.database.db, context, async tx => {
      const { authority, account } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreRead), now = await databaseNow(tx);
      const rows = await tx.select().from(jobs).where(and(eq(jobs.accountId, accountId),eq(jobs.operation,STORE_NODE_EXECUTION_OPERATION), ...(before ? [lt(jobs.id, before)] : []))).orderBy(desc(jobs.id)).limit(21);
      const items = await Promise.all(rows.slice(0, 20).map(row => this.summary(tx, row, can(authority, account), now, authority, account)));
      return StoreNodeExecutionHistorySchema.parse({ protocol, accountId, items, hasMore: rows.length > 20, nextCursor: rows.length > 20 ? items.at(-1)!.id : null });
    });
  }
  async cancel(context: TenantContext, accountId: string, executionId: string, raw: unknown) {
    const input = parse(CancelStoreNodeExecutionInputSchema, raw);
    return withTenant(this.database.db, context, async tx => {
      const { authority, account } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreManage);
      authorize(authority, Permission.StoreRead, { ownerId: account.createdBy });
      const row = await this.job(tx, accountId, executionId);
      this.requireCapability(row);
      if (row.requestChecksum !== input.requestChecksum) fail("store_node_request_changed");
      if (row.state === "cancelled") return this.view(tx, authority, row);
      if (!active.includes(row.state as typeof active[number]) || (await this.stepRows(tx, row)).length) fail("store_node_operation_unknown");
      await this.release(tx, row);
      const updated = await this.update(tx, row, { state: "cancelled", phase: "finished", completedAt: await databaseNow(tx) });
      await this.event(tx, authority, updated, "cancel"); return this.view(tx, authority, updated);
    });
  }

  async execute(peer: StoreNodePeer, operation: StoreNodeExecutionRpc, raw: unknown): Promise<unknown> {
    this.requireEnabled();
    switch (operation) {
      case "claim": return this.claim(peer, parse(StoreNodeExecutionClaimInputSchema, raw));
      case "permit": return this.permit(peer, parse(StoreNodeExecutionPermitInputSchema, raw));
      case "step": return this.step(peer, parse(StoreNodeExecutionStepInputSchema, raw));
      case "checkpoint": return this.checkpoint(peer, parse(StoreNodeExecutionCheckpointInputSchema, raw));
      case "complete": return this.complete(peer, parse(StoreNodeExecutionCompleteInputSchema, raw));
      case "receipt": return this.runtimeReceipt(peer, parse(StoreNodeExecutionCallSchema, raw));
    }
  }

  private async claim(peer: StoreNodePeer, input: StoreNodeExecutionClaimInput) {
    return this.identity.runtimeAccess(peer, input, true, async (tx, { account, node, binding, now }) => {
      const candidates = await tx.select().from(jobs).where(and(eq(jobs.accountId, account.id), inArray(jobs.state, ["waiting_node", "claimed", "running"]))).orderBy(asc(jobs.id)).for("update");
      for (const row of candidates) {
        if(!input.supportedOperations.includes(row.operation as typeof input.supportedOperations[number])){if(row.claimId)return this.claimView(null,now);continue;}
        if (row.expiresAt <= now || row.runExpiresAt && row.runExpiresAt <= now) {
          await this.release(tx, row); await this.update(tx, row, { state: row.claimId ? "unknown_outcome" : "expired", phase: "finished", errorCode: "store_node_execution_expired", completedAt: now });
          await this.publicationFailure(tx,row,!!row.claimId,"store_node_execution_expired");continue;
        }
        if (row.nodeId !== node.id || row.certificateGeneration !== node.certificateGeneration || row.authorizationGeneration !== account.authorizationGeneration || row.bindingRevision !== binding.revision) {
          await this.release(tx, row); await this.update(tx, row, { state: "authority_changed", phase: "finished", errorCode: "store_node_authority_changed", completedAt: now });
          await this.publicationFailure(tx,row,!!row.claimId,"store_node_authority_changed");continue;
        }
        if(row.operation===STORE_NODE_PUBLICATION_OPERATION&&!await this.publicationOwner().previewNodeDueInTransaction(tx,row,now))continue;
        let authority:TenantContext;
        try{authority=await this.origin(tx,row,account);}catch(error){
          if(!isPublication(row)||!knownAuthorityError(error))throw error;
          await this.release(tx,row);await this.update(tx,row,{state:"authority_changed",phase:"finished",errorCode:"store_node_authority_changed",completedAt:now});
          await this.publicationFailure(tx,row,!!row.claimId,"store_node_authority_changed");continue;
        }
        if (!input.supportedAuthorizationModes.includes(account.authorizationMode as "amazon_private" | "amazon_public" | "etsy_oauth")) {
          if (row.claimId) return this.claimView(null, now);
          const failed = await this.update(tx, row, { state: "failed", phase: "finished", errorCode: "store_node_configuration_invalid", completedAt: now });
          await this.publicationFailure(tx,row,false,"store_node_configuration_invalid");
          await this.event(tx, authority, failed, "configuration_rejected"); continue;
        }
        if (row.claimId) {
          // A restarted process recovers the old claim from its encrypted journal.
          // A new heartbeat session cannot take it over or acquire another use.
          if (row.sessionId !== input.sessionId) return this.claimView(null, now);
          return this.claimView(row, now);
        }
        const lease = await MarketplaceCredentialUse.claimInTransaction(this.database, this.secrets, this.audit, row.authorityCeiling, account.id, tx,isPublication(row)?Permission.StoreRead:Permission.StoreManage);
        const claimId = createEntityId(), runExpiresAt = new Date(Math.min(row.expiresAt.getTime(), now.getTime() + 240_000));
        const sealed = await this.secrets.withSecret(lease.encryptedEnvelope, rawCredential => {
          const credential = credentialSchema.parse(JSON.parse(rawCredential));
          const publicKey = account.authorizationMode === "amazon_public" ? this.amazonPublicKey() : null;
          if (account.authorizationMode === "amazon_public") {
            if (!publicKey) return { error: "store_node_configuration_invalid" as const };
            if (credential.kind !== "amazon_public" || credential.clientId !== publicKey)
              return { error: "store_node_application_reauthorization_required" as const };
          }
          return createStoreNodeSealedCredential(StoreNodeExecutionCredentialSchema.parse({
            account: { authorizationMode: account.authorizationMode, externalAccountId: account.externalAccountId, grantedScopes: account.grantedScopes,
              marketplaceIds: account.marketplaceIds, platform: account.platform, region: account.region }, credential,
            etsyAppKeySha256: account.platform === "etsy" ? hash(this.etsyPublicKey()) : null,
            ...(publicKey ? { amazonAppClientIdSha256: hash(publicKey) } : {}),
          }), { ...row, claimId }, node.publicKeyPem);
        });
        if ("error" in sealed) {
          await lease.releaseInTransaction(tx);
          const rejected = await this.update(tx, row, { state: "failed", phase: "finished", errorCode: sealed.error, completedAt: now });
          await this.publicationFailure(tx,row,false,sealed.error);
          await this.event(tx, authority, rejected, "configuration_rejected"); continue;
        }
        let encryptedTransportKey: string;
        try { encryptedTransportKey = this.secrets.encrypt(sealed.key.toString("base64url")); } finally { sealed.key.fill(0); }
        const updated = await this.update(tx, row, { state: "claimed", phase: "credential_ready", claimId, sessionId: input.sessionId,
          credentialUseId: lease.useId, credentialId: lease.credentialId, originalCredentialVersion: lease.credentialVersion, credentialVersion: lease.credentialVersion,
          encryptedTransportKey, sealedCredential: sealed.sealed, etsyAppKeySha256: account.platform === "etsy" ? hash(this.etsyPublicKey()) : null,
          runExpiresAt, leaseExpiresAt: new Date(Math.min(runExpiresAt.getTime(), now.getTime() + 30_000)), startedAt: now });
        await this.event(tx, lease.authority, updated, "claim"); return this.claimView(updated, now);
      }
      return this.claimView(null, now);
    });
  }

  private async permit(peer: StoreNodePeer, input: StoreNodeExecutionPermitInput) {
    const result=await this.identity.runtimeAccess(peer, input, true, async (tx, { account, binding, node, now }) => {
      const row = await this.runtimeJob(tx, account.id, input);
      try{await this.fresh(tx,row,account,binding.revision,now);}catch(error){
        if(!isFormalPublication(row)||!active.includes(row.state as typeof active[number])||!knownAuthorityError(error))throw error;
        const records=await this.stepRows(tx,row),uncertain=records.some(step=>step.requestClass==="amazon_listing_submit"&&step.outcome!=="not_sent");
        const code=applicationFailureCode(error)??(row.expiresAt<=now||row.runExpiresAt!==null&&row.runExpiresAt<=now?"store_node_execution_expired":"store_node_authority_changed");
        await this.release(tx,row);
        const rejected=await this.update(tx,row,{state:code==="store_node_authority_changed"?"authority_changed":uncertain?"unknown_outcome":"failed",phase:"finished",errorCode:code,completedAt:now});
        await this.publicationFailure(tx,row,uncertain,code);await this.event(tx,TenantContextSchema.parse(row.authorityCeiling),rejected,"permit_rejected");
        // Persist refusal before sending the error. Throwing inside withTenant would undo the terminal receipt.
        return {rejected:true as const,code};
      }
      const records = await this.stepRows(tx, row), prior = records.find(value => value.id === input.stepId);
      if (prior) {
        if (prior.ordinal !== input.ordinal || prior.requestClass !== input.requestClass || prior.requestDigest !== input.requestDigest) fail("store_node_request_changed");
        return this.permitView(row, prior);
      }
      if (records.some(value => value.ordinal === input.ordinal) || input.ordinal !== records.length + 1) fail("store_node_request_changed");
      this.requestPolicy(account, row, records, input.requestClass);
      const lease = await this.resume(tx, row);
      if (input.requestClass === "etsy_refresh") await lease.beforeCredentialRefreshInTransaction(tx); else await lease.current(tx);
      const expiresAt = new Date(Math.min(now.getTime() + 20_000, row.runExpiresAt!.getTime(), node.certificateExpiresAt!.getTime(), node.sessionExpiresAt!.getTime(), binding.leaseExpiresAt!.getTime()));
      if (expiresAt <= now) fail("store_node_execution_expired");
      const [record] = await tx.insert(steps).values({ id: input.stepId, tenantId: row.tenantId, executionId: row.id, ordinal: input.ordinal,
        requestClass: input.requestClass, requestDigest: input.requestDigest, permitId: createEntityId(), permitExpiresAt: expiresAt, createdAt: now }).returning();
      await this.update(tx, row, { state: "running", phase: input.requestClass === "etsy_refresh" ? "refresh_pending" : "collecting",
        leaseExpiresAt: new Date(Math.min(row.runExpiresAt!.getTime(), now.getTime() + 30_000)) });
      return this.permitView(row, record!);
    });
    if("rejected" in result)fail(result.code);return result;
  }

  private async step(peer: StoreNodePeer, input: StoreNodeExecutionStepInput) {
    return this.identity.runtimeAccess(peer, input, false, async (tx, { account, now }) => {
      const row = await this.runtimeJob(tx, account.id, input), record = (await this.stepRows(tx, row)).find(value => value.id === input.stepId);
      if (!record || record.permitId !== input.permitId || record.requestDigest !== input.requestDigest) fail("store_node_request_changed");
      const receiptChecksum = hash(JSON.stringify([input.stepId, input.permitId, input.requestDigest, input.responseDigest, input.httpStatus, input.outcome]));
      if (record.receiptChecksum && record.receiptChecksum !== receiptChecksum) fail("store_node_request_changed");
      if (!record.receiptChecksum) await tx.update(steps).set({ outcome: input.outcome, responseDigest: input.responseDigest, httpStatus: input.httpStatus,
        receiptChecksum, completedAt: now }).where(eq(steps.id, record.id));
      return StoreNodeExecutionAckSchema.parse({ protocol, executionId: row.id, claimId: row.claimId, acknowledged: true, observedAt: now.toISOString() });
    });
  }

  private async checkpoint(peer: StoreNodePeer, input: StoreNodeExecutionCheckpointInput) {
    return this.identity.runtimeAccess(peer, input, false, async (tx, { account, now }) => {
      const row = await this.runtimeJob(tx, account.id, input); this.cipherChecksum(input);
      if (input.originalCredentialVersion !== row.originalCredentialVersion) fail();
      if (row.checkpointChecksum) { if (row.checkpointChecksum !== input.payloadChecksum) fail("store_node_request_changed"); return this.receiptView(row, now); }
      if (account.platform !== "etsy" || row.authorizationGeneration !== account.authorizationGeneration || account.credentialUseId !== row.credentialUseId) fail();
      const records = await this.stepRows(tx, row);
      if (!records.some(value => value.requestClass === "etsy_refresh" && value.outcome === "received" && value.httpStatus === 200)) fail("store_node_operation_unknown");
      const payload = parse(StoreNodeExecutionCheckpointPayloadSchema, await this.open(row, input.payload, "checkpoint")), lease = await this.resume(tx, row);
      await this.secrets.withSecret(lease.encryptedEnvelope, rawCredential => {
        const original = credentialSchema.parse(JSON.parse(rawCredential)), keys = Object.keys(original).sort();
        if (JSON.stringify(Object.keys(payload.credential).sort()) !== JSON.stringify(keys) || !payload.credential.refreshToken
          || keys.some(key => key !== "refreshToken" && original[key] !== payload.credential[key])) fail("store_node_policy_rejected");
      });
      const expiresAt = new Date(payload.expiresAt);
      if (expiresAt.getTime() > now.getTime() + 91 * 86_400_000) fail("store_node_policy_rejected");
      const saved = await lease.checkpointCredentialInTransaction(tx, payload.credential, expiresAt);
      const updated = await this.update(tx, row, { checkpointChecksum: input.payloadChecksum, credentialVersion: saved.version,
        phase: active.includes(row.state as typeof active[number]) ? "credential_checkpointed" : row.phase });
      return this.receiptView(updated, now);
    });
  }

  private async complete(peer: StoreNodePeer, input: StoreNodeExecutionCompleteInput) {
    return this.identity.runtimeAccess(peer, input, false, async (tx, { account, binding, node, now }) => {
      const row = await this.runtimeJob(tx, account.id, input); this.cipherChecksum(input);
      if (row.completionChecksum) { if (row.completionChecksum !== input.payloadChecksum) fail("store_node_request_changed"); return this.receiptView(row, now); }
      if (!active.includes(row.state as typeof active[number])) fail("store_node_execution_expired");
      const payload = parse(StoreNodeExecutionCompletionPayloadSchema, await this.open(row, input.payload, "completion"));
      let authority: TenantContext;
      try {
        const selected = await this.identity.executionBinding(tx, account, true);
        if (selected.node.id !== node.id || node.sessionId !== row.sessionId || node.sessionId !== input.sessionId) fail();
        authority = await this.fresh(tx, row, account, binding.revision, now);
      } catch (error) {
        const applicationCode = applicationFailureCode(error);
        if (applicationCode) {
          await this.release(tx, row);
          const uncertain = (await this.stepRows(tx, row)).some(step => step.outcome === null || step.outcome === "unknown"||isFormalPublication(row)&&step.requestClass==="amazon_listing_submit"&&step.outcome!=="not_sent");
          const rejected = await this.update(tx, row, { state: uncertain ? "unknown_outcome" : "failed", phase: "finished",
            errorCode: applicationCode, completionChecksum: input.payloadChecksum, completedAt: now });
          await this.publicationFailure(tx,row,uncertain,applicationCode);
          await this.event(tx, TenantContextSchema.parse(row.authorityCeiling), rejected, "configuration_rejected");
          return this.receiptView(rejected, now);
        }
        if (!knownAuthorityError(error)) throw error;
        await this.release(tx, row);
        const expired = row.expiresAt <= now || row.runExpiresAt !== null && row.runExpiresAt <= now;
        const updated = await this.update(tx, row, { state: expired ? "unknown_outcome" : "authority_changed", phase: "finished",
          errorCode: expired ? "store_node_execution_expired" : "store_node_authority_changed", completionChecksum: input.payloadChecksum, completedAt: now });
        await this.publicationFailure(tx,row,true,updated.errorCode!);
        return this.receiptView(updated, now);
      }
      const records = await this.stepRows(tx, row), lease = await this.resume(tx, row);
      if (payload.outcome === "failure"||payload.outcome==="unknown") {
        if(isPublication(row)){await this.publicationFailure(tx,row,payload.outcome==="unknown",payload.code);await lease.releaseInTransaction(tx);}
        else if (payload.outcome === "failure" && !applicationCodeValue(payload.code)) await this.capabilities.recordNodeFailure(lease, connectorFailure(account, payload.code), tx); else await lease.releaseInTransaction(tx);
        const updated = await this.update(tx, row, { state: payload.outcome === "unknown" ? "unknown_outcome" : "failed", phase: "finished",
          errorCode: payload.code, completionChecksum: input.payloadChecksum, completedAt: now });
        await this.event(tx, authority, updated, "complete"); return this.receiptView(updated, now);
      }
      if(isFormalPublication(row)){
        const expected=row.operation===STORE_NODE_PUBLICATION_SUBMIT_OPERATION?"publication_submit":"publication_status";
        const requestClass=row.operation===STORE_NODE_PUBLICATION_SUBMIT_OPERATION?"amazon_listing_submit":"amazon_listing_status";
        if(payload.outcome!==expected||!(payload.outcome==="publication_submit"||payload.outcome==="publication_status")||records.length!==2
          ||records[0]?.requestClass!=="amazon_lwa"||records[1]?.requestClass!==requestClass
          ||records.some(value=>value.outcome!=="received"||!value.httpStatus||value.httpStatus<200||value.httpStatus>=300))fail("store_node_policy_rejected");
        try{
          await this.noSecrets(lease,row,payload.result);
          await this.publicationOwner().adoptSubmissionNodeInTransaction(tx,row,payload.result);
        }catch(error){
          if(!knownAuthorityError(error))throw error;
          await this.publicationFailure(tx,row,true,"store_node_policy_rejected");await lease.releaseInTransaction(tx);
          const rejected=await this.update(tx,row,{state:"unknown_outcome",phase:"finished",errorCode:"store_node_policy_rejected",completionChecksum:input.payloadChecksum,completedAt:now});
          await this.event(tx,authority,rejected,"complete");return this.receiptView(rejected,now);
        }
        await lease.releaseInTransaction(tx);
        const updated=await this.update(tx,row,{state:"succeeded",phase:"finished",completionChecksum:input.payloadChecksum,completedAt:now});
        await this.event(tx,authority,updated,"complete");return this.receiptView(updated,now);
      }
      if(row.operation===STORE_NODE_PUBLICATION_OPERATION){
        if(payload.outcome!=="publication_validation"||records.length!==2||records[0]?.requestClass!=="amazon_lwa"||records[1]?.requestClass!=="amazon_listing_validation_preview"
          ||records.some(value=>value.outcome!=="received"||!value.httpStatus||value.httpStatus<200||value.httpStatus>=300))fail("store_node_policy_rejected");
        await this.noSecrets(lease,row,payload.result);
        await this.publicationOwner().adoptPreviewNodeInTransaction(tx,row,payload.result);await lease.releaseInTransaction(tx);
        const updated=await this.update(tx,row,{state:"succeeded",phase:"finished",completionChecksum:input.payloadChecksum,completedAt:now});
        await this.event(tx,authority,updated,"complete");return this.receiptView(updated,now);
      }
      if(payload.outcome!=="success")fail("store_node_policy_rejected");
      const capabilityInput=SyncMarketplaceCapabilitiesInputSchema.parse(row.input);
      if (!records.length || records.some(value => value.outcome !== "received" || !value.httpStatus || value.httpStatus < 200 || value.httpStatus >= 300)
        || account.platform === "etsy" && !row.checkpointChecksum) fail("store_node_operation_unknown");
      const result = payload.result, syncedAt = new Date(result.syncedAt), expiresAt = new Date(result.expiresAt);
      // Preserve the source clock and record its proposed expiry in the same audit.
      // The accepted snapshot's TTL is independently capped by the central clock.
      if (syncedAt.getTime() < row.startedAt!.getTime() - 30_000 || syncedAt.getTime() > now.getTime() + 30_000
        || expiresAt.getTime() !== syncedAt.getTime() + capabilityInput.ttlHours * 3_600_000
        || marketplaceCapabilityChecksum(result.data) !== result.sourceChecksum) fail("store_node_policy_rejected");
      await this.noSecrets(lease, row, result);
      const acceptedExpiry = new Date(Math.min(expiresAt.getTime(), now.getTime() + capabilityInput.ttlHours * 3_600_000));
      const snapshot = await this.capabilities.adoptNodeResult(lease, { ...result, syncedAt, expiresAt: acceptedExpiry }, tx);
      const updated = await this.update(tx, row, { state: "succeeded", phase: "finished", snapshotId: snapshot.id, completionChecksum: input.payloadChecksum, completedAt: now });
      await this.event(tx, authority, updated, "complete", { sourceSyncedAt: result.syncedAt, sourceExpiresAt: result.expiresAt, acceptedExpiresAt: acceptedExpiry.toISOString() }); return this.receiptView(updated, now);
    });
  }

  private async runtimeReceipt(peer: StoreNodePeer, input: StoreNodeExecutionCall) {
    return this.identity.runtimeAccess(peer, input, false, async (tx, { account, now }) => this.receiptView(await this.runtimeJob(tx, account.id, input), now));
  }
  private async fresh(tx: TenantTransaction, row: Job, account: MarketplaceAccountRow, revision: number, now: Date) {
    if (!row.claimId || !["claimed", "running"].includes(row.state) || row.authorizationGeneration !== account.authorizationGeneration || row.bindingRevision !== revision) fail();
    if (!row.runExpiresAt || row.runExpiresAt <= now || row.expiresAt <= now || !row.leaseExpiresAt || row.leaseExpiresAt <= now) fail("store_node_execution_expired");
    if (account.authorizationMode === "amazon_public") {
      const key = this.amazonPublicKey();
      if (!key) fail("store_node_configuration_invalid");
      const seed = await this.seed(row);
      if (seed.account.authorizationMode !== "amazon_public" || seed.credential.kind !== "amazon_public" || seed.credential.clientId !== key
        || seed.amazonAppClientIdSha256 !== hash(key)) fail("store_node_application_reauthorization_required");
    }
    return this.origin(tx, row, account);
  }
  private async origin(tx: TenantTransaction, row: Job, account: MarketplaceAccountRow) {
    if(row.operation===STORE_NODE_PUBLICATION_OPERATION)return (await this.publicationOwner().assertPreviewNodeInTransaction(tx,row)).authority;
    if(isFormalPublication(row))return (await this.publicationOwner().assertSubmissionNodeInTransaction(tx,row)).authority;
    const ceiling = TenantContextSchema.parse(row.authorityCeiling);
    if (ceiling.tenantId !== account.tenantId || ceiling.userId !== row.createdBy) fail();
    const current = await currentMarketplaceAuthority(tx, ceiling, Permission.StoreManage, account);
    authorize(current, Permission.StoreRead, { ownerId: account.createdBy });
    if (await this.member(tx, current) !== row.membershipId) fail(); return current;
  }
  private async member(tx: TenantTransaction, context: TenantContext) {
    const [member] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, context.userId), eq(memberships.status, "active"))).for("share");
    if (!member) fail(); return member.id;
  }
  private async runtimeJob(tx: TenantTransaction, accountId: string, input: StoreNodeExecutionCall) {
    const row = await this.job(tx, accountId, input.executionId);
    if (row.nodeId !== input.nodeId || row.certificateGeneration !== input.certificateGeneration || row.claimId !== input.claimId || row.sessionId !== input.sessionId || row.requestChecksum !== input.requestChecksum) fail(); return row;
  }
  private async job(tx: TenantTransaction, accountId: string, id: string) {
    const [row] = await tx.select().from(jobs).where(and(eq(jobs.accountId, accountId), eq(jobs.id, id))).for("update");
    if (!row) throw new NotFoundException({ code: "store_node_execution_not_found" }); return row;
  }
  private stepRows(tx: TenantTransaction, row: Job) { return tx.select().from(steps).where(eq(steps.executionId, row.id)).orderBy(asc(steps.ordinal)); }
  private async update(tx: TenantTransaction, row: Job, values: Partial<typeof jobs.$inferInsert>): Promise<Job> {
    const [saved] = await tx.update(jobs).set({ ...values, updatedAt: await databaseNow(tx) }).where(eq(jobs.id, row.id)).returning(); return saved!;
  }
  private resume(tx: TenantTransaction, row: Job) {
    if (!row.credentialUseId || !row.credentialId || !row.credentialVersion) fail();
    return MarketplaceCredentialUse.resumeInTransaction(this.database, this.secrets, this.audit, row.authorityCeiling, row.accountId,
      { generation: row.authorizationGeneration, useId: row.credentialUseId, credentialId: row.credentialId, credentialVersion: row.credentialVersion, checkpointed: row.checkpointChecksum !== null }, tx,isPublication(row)?Permission.StoreRead:Permission.StoreManage);
  }
  private async release(tx: TenantTransaction, row: Job) {
    if (!row.claimId) return;
    try { await (await this.resume(tx, row)).releaseInTransaction(tx); }
    catch (error) { if (!(error instanceof Error) || !["ConflictException", "UnauthorizedException"].includes(error.constructor.name)) throw error; }
  }
  private requestPolicy(account: MarketplaceAccountRow, row: Job, records: Step[], kind: StoreNodeExecutionRequestClass) {
    if(isFormalPublication(row)){
      const expected=records.length===0?"amazon_lwa":records.length===1?row.operation===STORE_NODE_PUBLICATION_SUBMIT_OPERATION?"amazon_listing_submit":"amazon_listing_status":null;
      if(account.platform!=="amazon"||kind!==expected||records.some(step=>step.outcome!=="received"||!step.httpStatus||step.httpStatus<200||step.httpStatus>=300))fail("store_node_policy_rejected");return;
    }
    if(row.operation===STORE_NODE_PUBLICATION_OPERATION){
      const expected=records.length===0?"amazon_lwa":records.length===1?"amazon_listing_validation_preview":null;
      if(account.platform!=="amazon"||kind!==expected||records.some(step=>step.outcome!=="received"||!step.httpStatus||step.httpStatus<200||step.httpStatus>=300))fail("store_node_policy_rejected");return;
    }
    if(["amazon_listing_validation_preview","amazon_listing_submit","amazon_listing_status"].includes(kind))fail("store_node_policy_rejected");
    const capabilityInput=SyncMarketplaceCapabilitiesInputSchema.parse(row.input);
    if (!kind.startsWith(account.platform + "_")) fail("store_node_policy_rejected");
    const count = records.filter(value => value.requestClass === kind).length;
    const max = kind === "amazon_product_definition" || kind === "amazon_schema" || kind === "amazon_meta_schema" ? capabilityInput.amazonProductTypes.length * account.marketplaceIds.length
      : kind === "etsy_taxonomy_properties" ? capabilityInput.etsyTaxonomyNodeIds.length : 1;
    if (count >= max || records.some(value => value.outcome === "unknown" || value.outcome === "not_sent")) fail("store_node_policy_rejected");
    if (account.platform === "etsy" && kind !== "etsy_refresh" && !row.checkpointChecksum) fail("store_node_operation_unknown");
  }
  private cipherChecksum(input: StoreNodeExecutionCompleteInput | StoreNodeExecutionCheckpointInput) { if (storeNodeExecutionPayloadChecksum(input.payload) !== input.payloadChecksum) fail("store_node_request_changed"); }
  private async open(row: Job, payload: StoreNodeExecutionCompleteInput["payload"], purpose: "completion" | "checkpoint") {
    if (!row.encryptedTransportKey || !row.claimId) fail();
    return this.secrets.withSecret(row.encryptedTransportKey, raw => {
      const key = Buffer.from(raw, "base64url");
      try { return openStoreNodeExecutionPayload(payload, key, { ...row, claimId: row.claimId! }, purpose); } finally { key.fill(0); }
    });
  }
  private async noSecrets(lease: MarketplaceCredentialUse, row: Job, result: unknown) {
    const text = JSON.stringify(result);
    const seed = await this.seed(row);
    await this.secrets.withSecret(lease.encryptedEnvelope, raw => {
      const values = [seed.credential, credentialSchema.parse(JSON.parse(raw))].flatMap(value => Object.entries(value)
        .filter(([key, value]) => /token|secret|password/i.test(key) && value).map(([, value]) => value));
      if (process.env.ETSY_APP_SHARED_SECRET) values.push(process.env.ETSY_APP_SHARED_SECRET);
      if (process.env.AMAZON_SPAPI_LWA_CLIENT_SECRET) values.push(process.env.AMAZON_SPAPI_LWA_CLIENT_SECRET);
      if (values.some(value => text.includes(value)||text.includes(JSON.stringify(value).slice(1,-1)))) fail("store_node_secret_output_rejected");
    });
  }
  private async seed(row: Job) {
    if (!row.encryptedTransportKey || !row.sealedCredential || !row.claimId) fail();
    return this.secrets.withSecret(row.encryptedTransportKey, raw => {
      const key = Buffer.from(raw, "base64url"), cipher = row.sealedCredential!;
      try { return openStoreNodeExecutionCredentialSeed({ nonce: cipher.nonce, tag: cipher.tag, ciphertext: cipher.ciphertext }, key, { ...row, claimId: row.claimId! }); }
      finally { key.fill(0); }
    });
  }
  private claimView(row: Job | null, now: Date) { return StoreNodeExecutionClaimSchema.parse({ protocol, state: row ? "lease" : "empty", lease: row ? StoreNodeExecutionLeaseSchema.parse({
    protocol, id: row.id, accountId: row.accountId, requestId: row.requestId, requestChecksum: row.requestChecksum, operation: row.operation, input: row.input,
    nodeId: row.nodeId, certificateGeneration: row.certificateGeneration, authorizationGeneration: row.authorizationGeneration, bindingRevision: row.bindingRevision,
    claimId: row.claimId, sessionId: row.sessionId, credentialUseId: row.credentialUseId, credentialId: row.credentialId, credentialVersion: row.originalCredentialVersion,
    sealedCredential: row.sealedCredential, expiresAt: row.expiresAt.toISOString(), runExpiresAt: row.runExpiresAt!.toISOString() }) : null, observedAt: now.toISOString() }); }
  private permitView(row: Job, step: Step) { return StoreNodeExecutionPermitSchema.parse({ protocol, executionId: row.id, claimId: row.claimId,
    stepId: step.id, requestDigest: step.requestDigest, permitId: step.permitId, expiresAt: step.permitExpiresAt.toISOString() }); }
  private receiptView(row: Job, now: Date) { return StoreNodeExecutionRuntimeReceiptSchema.parse({ protocol, executionId: row.id, claimId: row.claimId,
    state: row.state, phase: row.phase, checkpointChecksum: row.checkpointChecksum, credentialVersion: row.credentialVersion, completionChecksum: row.completionChecksum,
    snapshotId: row.snapshotId, observedAt: now.toISOString() }); }
  private async summary(tx: TenantTransaction, row: Job, canManage: boolean, now: Date, context: TenantContext, account: MarketplaceAccountRow): Promise<StoreNodeExecutionSummary> {
    const running = active.includes(row.state as typeof active[number]);
    let changed = running && (row.authorizationGeneration !== account.authorizationGeneration || ["disabled", "revoked"].includes(account.status));
    if (running && !changed) {
      try {
        const current = await this.identity.executionBinding(tx, account, false);
        changed = current.node.id !== row.nodeId || current.node.certificateGeneration !== row.certificateGeneration || current.binding.revision !== row.bindingRevision;
      } catch (error) {
        if (!(error instanceof Error) || !["ForbiddenError", "ForbiddenException", "ConflictException", "UnauthorizedException"].includes(error.constructor.name)) throw error;
        changed = true;
      }
    }
    const expired = running && (row.expiresAt <= now || row.runExpiresAt !== null && row.runExpiresAt <= now);
    // A read never silently mutates/retries an expired task.
    const state = changed ? "authority_changed" : expired ? row.claimId ? "unknown_outcome" : "expired" : row.state;
    const snapshot = row.snapshotId ? await this.capabilities.snapshotInTransaction(tx, context, row.accountId, row.snapshotId) : null;
    return StoreNodeExecutionSummarySchema.parse({ ...pins(row), id: row.id, requestId: row.requestId, requestChecksum: row.requestChecksum, operation: row.operation,
      state, phase: changed || expired ? "finished" : row.phase, errorCode: changed ? "store_node_authority_changed" : expired ? "store_node_execution_expired" : row.errorCode,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null, canCancel: canManage && !changed && !expired && running && !(await this.stepRows(tx, row)).length,
      snapshotId: row.snapshotId, snapshotVersion: snapshot?.version ?? null });
  }
  private async view(tx: TenantTransaction, context: TenantContext, row: Job) {
    const { account } = await lockMarketplaceAccount(tx, context, row.accountId, Permission.StoreRead);
    const snapshot = row.snapshotId ? await this.capabilities.snapshotInTransaction(tx, context, row.accountId, row.snapshotId) : null;
    return StoreNodeExecutionViewSchema.parse({ ...await this.summary(tx, row, can(context, account), await databaseNow(tx), context, account), input: row.input, snapshot });
  }
  private event(tx: TenantTransaction, context: TenantContext, row: Job, action: string, metadata: Record<string, string> = {}) { return this.audit.recordInTransaction(tx, context, {
    action: `store_node_execution.${action}`, resourceType: "store_node_execution", resourceId: row.id, result: ["failed", "unknown_outcome", "authority_changed"].includes(row.state) ? "failure" : "success",
    metadata: { accountId: row.accountId, nodeId: row.nodeId, certificateGeneration: row.certificateGeneration, authorizationGeneration: row.authorizationGeneration,
      bindingRevision: row.bindingRevision, requestChecksum: row.requestChecksum, operation: row.operation, state: row.state, ...metadata } }); }
  private etsyPublicKey() { const key = process.env.ETSY_APP_KEYSTRING?.trim(); if (!key) throw new ServiceUnavailableException({ code: "store_node_configuration_invalid" }); return key; }
  private amazonPublicKey() { const key = process.env.AMAZON_SPAPI_LWA_CLIENT_ID?.trim(); return key && key.length <= 16384 ? key : null; }
  private enabled() { return process.env.STORE_NODE_EXECUTION_ENABLED === "1" && process.env.STORE_NODE_RUNTIME_ENABLED === "1"; }
  private publicationOwner(){if(!this.publications)throw new ServiceUnavailableException({code:"store_node_configuration_invalid"});return this.publications;}
  private async publicationFailure(tx:TenantTransaction,row:Job,unknown:boolean,code:string){
    if(row.operation===STORE_NODE_PUBLICATION_OPERATION)await this.publicationOwner().failPreviewNodeInTransaction(tx,row,unknown,code);
    else if(isFormalPublication(row))await this.publicationOwner().failSubmissionNodeInTransaction(tx,row,unknown,code);
  }
  private requireCapability(row:Job){if(row.operation!==STORE_NODE_EXECUTION_OPERATION)throw new NotFoundException({code:"store_node_execution_not_found"});}
  private requireEnabled() { if (!this.enabled()) throw new ServiceUnavailableException({ code: "store_node_configuration_invalid" }); }
}
function pins(row: Job) { return { nodeId: row.nodeId, certificateGeneration: row.certificateGeneration, authorizationGeneration: row.authorizationGeneration, bindingRevision: row.bindingRevision }; }
function isFormalPublication(row:Job){return row.operation===STORE_NODE_PUBLICATION_SUBMIT_OPERATION||row.operation===STORE_NODE_PUBLICATION_STATUS_OPERATION;}
function isPublication(row:Job){return row.operation===STORE_NODE_PUBLICATION_OPERATION||isFormalPublication(row);}
function can(context: TenantContext, account: MarketplaceAccountRow) { try { authorize(context, Permission.StoreManage, { ownerId: account.createdBy }); return true; } catch { return false; } }
function supportedMode(account: MarketplaceAccountRow) { return account.platform === "amazon" && ["amazon_private", "amazon_public"].includes(account.authorizationMode) || account.platform === "etsy" && account.authorizationMode === "etsy_oauth"; }
function applicationCodeValue(code: string): code is "store_node_configuration_invalid" | "store_node_application_reauthorization_required" {
  return code === "store_node_configuration_invalid" || code === "store_node_application_reauthorization_required";
}
function applicationFailureCode(error: unknown) {
  if (!(error instanceof ConflictException)) return null;
  const value = error.getResponse();
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" && applicationCodeValue(value.code) ? value.code : null;
}
function knownAuthorityError(error:unknown){return error instanceof Error&&["ForbiddenError","ForbiddenException","ConflictException","UnauthorizedException","PublicationAuthorityError","CatalogAccessNotFoundError","NotFoundException"].includes(error.constructor.name);}
function connectorFailure(account: MarketplaceAccountRow, code: string) {
  const kind = code === "store_node_upstream_authorization" ? "authorization" : code === "store_node_upstream_validation" ? "validation"
    : code === "store_node_upstream_rate_limited" ? "rate_limited" : code === "store_node_upstream_retryable" ? "upstream_retryable" : "upstream_terminal";
  return new MarketplaceConnectorError(MarketplacePlatformSchema.parse(account.platform), kind, "Node capability execution failed");
}
