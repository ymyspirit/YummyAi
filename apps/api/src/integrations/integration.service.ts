import { createHash, randomBytes } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { permissionScope, Permission } from "@yummyai/authz";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { RevokedIntegrationApiClientViewSchema } from "@yummyai/contracts/integration";
import {
  CreateIntegrationApiClientInputSchema, CreatedIntegrationApiClientViewSchema, CreatedWebhookEndpointViewSchema,
  CreateWebhookEndpointInputSchema, IntegrationApiClientViewSchema, IntegrationRetentionRunViewSchema,
  IntegrationWorkspaceViewSchema, PublishWebhookEventInputSchema, ReplayWebhookDeliveryInputSchema,
  RevokeIntegrationApiClientInputSchema, RotateWebhookSecretInputSchema, RunIntegrationRetentionInputSchema,
  UpdateWebhookEndpointInputSchema, WebhookDeliveryAttemptViewSchema, WebhookDeliveryViewSchema, WebhookEndpointViewSchema,
  WebhookEventViewSchema, createEntityId,
  type CreateIntegrationApiClientInput, type CreateWebhookEndpointInput, type IntegrationApiClientView,
  type IntegrationWorkspaceView, type PublishWebhookEventInput, type ReplayWebhookDeliveryInput,
  type RevokeIntegrationApiClientInput, type RotateWebhookSecretInput, type RunIntegrationRetentionInput,
  type TenantContext, type UpdateWebhookEndpointInput, type WebhookDeliveryView, type WebhookEndpointView,
} from "@yummyai/contracts";
import {
  integrationApiClientEvents, integrationApiClients, integrationRetentionRuns, webhookDeliveries,
  webhookDeliveryAttempts, webhookEndpointEvents, webhookEndpoints, webhookEvents,
  type DatabaseConnection, type TenantTransaction, withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, isNotNull, lt, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, INTEGRATION_SECRET_VAULT, WEBHOOK_DELIVERY_ENQUEUER } from "../platform.tokens.js";
import { integrationAgentCatalog } from "./agent-capability.catalog.js";
import {
  currentIntegrationClientAuthority, integrationClientAccessible, integrationClientAdmission,
  integrationClientContextAuthority, integrationClientNow, integrationClientRequestChecksum, pinIntegrationApiDelegation,
} from "./integration-client-authority.js";

@Injectable()
export class IntegrationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(INTEGRATION_SECRET_VAULT) private readonly secrets: SecretVault,
    @Inject(WEBHOOK_DELIVERY_ENQUEUER) private readonly enqueuer: WebhookDeliveryEnqueuer,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createApiClient(context: TenantContext, rawInput: CreateIntegrationApiClientInput) {
    const input = CreateIntegrationApiClientInputSchema.parse(rawInput);
    const requestChecksum = integrationClientRequestChecksum(input);
    return withTenant(this.database.db, context, async (tx) => {
      const { current, membershipId } = await currentIntegrationClientAuthority(tx, context, Permission.IntegrationManage);
      await lock(tx, `integration-api-client:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(integrationApiClients).where(eq(integrationApiClients.idempotencyKey, input.idempotencyKey)).limit(1);
      const now = await integrationClientNow(tx);
      if (replayed) {
        if (replayed.createdBy !== current.userId || !integrationClientAccessible(current, Permission.IntegrationManage, replayed.createdBy)
          || !sameClientRequest(replayed, input, requestChecksum)) throw new ConflictException("integration_client_request_conflict");
        return CreatedIntegrationApiClientViewSchema.parse({ contextAuthority: integrationClientContextAuthority(current), client: apiClientView(replayed, now), bearerToken: null });
      }
      if (input.expiresAt && Date.parse(input.expiresAt) <= now.getTime()) throw new ConflictException("integration_client_expiry_invalid");
      const delegation = pinIntegrationApiDelegation(current, membershipId, input, now);
      const id = createEntityId(), bearerToken = `yai_${id}.${randomBytes(32).toString("base64url")}`;
      const [row] = await tx.insert(integrationApiClients).values({ id, tenantId: current.tenantId, label: input.label,
        keyPrefix: `yai_${id}`, secretDigest: hashSecret(bearerToken), scopes: input.scopes,
        expiresAt: input.expiresAt ? sql`${input.expiresAt}::timestamptz` : null,
        idempotencyKey: input.idempotencyKey, createdBy: current.userId, delegation, delegationRequest: input }).returning();
      await tx.insert(integrationApiClientEvents).values({ id: createEntityId(), tenantId: current.tenantId, clientId: id,
        action: "created", reasonCode: "CLIENT_CREATED", idempotencyKey: input.idempotencyKey, actorUserId: current.userId });
      await this.audit.recordInTransaction(tx, current, { action: "integration.api_client.create", resourceType: "integration_api_client",
        resourceId: id, result: "success", metadata: { requestChecksum, scopes: input.scopes } });
      return CreatedIntegrationApiClientViewSchema.parse({ contextAuthority: integrationClientContextAuthority(current), client: apiClientView(row!, now), bearerToken });
    });
  }

  async revokeApiClient(context: TenantContext, clientId: string, rawInput: RevokeIntegrationApiClientInput) {
    const input = RevokeIntegrationApiClientInputSchema.parse(rawInput);
    return withTenant(this.database.db, context, async (tx) => {
      const { current } = await currentIntegrationClientAuthority(tx, context, Permission.IntegrationManage);
      await lock(tx, `integration-api-client:${clientId}`);
      const [client] = await tx.select().from(integrationApiClients).where(eq(integrationApiClients.id, clientId)).limit(1).for("update");
      if (!client || !integrationClientAccessible(current, Permission.IntegrationManage, client.createdBy)) throw new NotFoundException("integration_client_not_found");
      const [existingEvent] = await tx.select().from(integrationApiClientEvents).where(and(eq(integrationApiClientEvents.clientId, clientId), eq(integrationApiClientEvents.idempotencyKey, input.idempotencyKey))).limit(1);
      const now = await integrationClientNow(tx);
      if (existingEvent) {
        if (existingEvent.action !== "revoked" || existingEvent.actorUserId !== current.userId || existingEvent.reasonCode !== input.reasonCode || client.status !== "revoked")
          throw new ConflictException("integration_client_request_conflict");
        return RevokedIntegrationApiClientViewSchema.parse({ contextAuthority: integrationClientContextAuthority(current), client: apiClientView(client, now) });
      }
      if (client.status !== input.expectedStatus) throw new ConflictException("integration_client_not_active");
      await tx.insert(integrationApiClientEvents).values({ id: createEntityId(), tenantId: current.tenantId, clientId, action: "revoked", reasonCode: input.reasonCode, idempotencyKey: input.idempotencyKey, actorUserId: current.userId });
      const [updated] = await tx.update(integrationApiClients).set({ status: "revoked", revokedAt: sql`clock_timestamp()` }).where(eq(integrationApiClients.id, clientId)).returning();
      const requestChecksum = createHash("sha256").update(canonicalJson({ version: 1, operation: "integration-api-client-revoke", clientId, input })).digest("hex");
      await this.audit.recordInTransaction(tx, current, { action: "integration.api_client.revoke", resourceType: "integration_api_client",
        resourceId: clientId, result: "success", metadata: { requestChecksum, reasonCode: input.reasonCode } });
      return RevokedIntegrationApiClientViewSchema.parse({ contextAuthority: integrationClientContextAuthority(current), client: apiClientView(updated!, now) });
    });
  }

  async createWebhookEndpoint(context: TenantContext, rawInput: CreateWebhookEndpointInput) {
    const input = CreateWebhookEndpointInputSchema.parse(rawInput);
    const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `webhook-endpoint:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (hash({ label: replayed.label, url: replayed.url, eventTypes: replayed.eventTypes, maxAttempts: replayed.maxAttempts }) !== hash({ label: input.label, url: input.url, eventTypes: input.eventTypes, maxAttempts: input.maxAttempts })) throw new ConflictException("Webhook endpoint idempotency key was reused with changed input");
        return { row: replayed, signingSecret: null };
      }
      const id = createEntityId();
      const [row] = await tx.insert(webhookEndpoints).values({ id, tenantId: context.tenantId, label: input.label, url: input.url, eventTypes: input.eventTypes, maxAttempts: input.maxAttempts, encryptedSigningSecret: this.secrets.encrypt(signingSecret), signingKeyPrefix: signingSecret.slice(0, 14), idempotencyKey: input.idempotencyKey, createdBy: context.userId }).returning();
      await appendEndpointEvent(tx, context, row!, "created", "ENDPOINT_CREATED", input.idempotencyKey);
      return { row: row!, signingSecret };
    });
    const view = CreatedWebhookEndpointViewSchema.parse({ endpoint: webhookEndpointView(result.row), signingSecret: result.signingSecret });
    await this.audit.record(context, { action: "integration.webhook_endpoint.create", resourceType: "webhook_endpoint", resourceId: view.endpoint.id, result: "success", metadata: { eventTypes: view.endpoint.eventTypes } });
    return view;
  }

  async updateWebhookEndpoint(context: TenantContext, endpointId: string, rawInput: UpdateWebhookEndpointInput) {
    const input = UpdateWebhookEndpointInputSchema.parse(rawInput);
    const row = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `webhook-endpoint:${endpointId}`);
      const [event] = await tx.select().from(webhookEndpointEvents).where(and(eq(webhookEndpointEvents.endpointId, endpointId), eq(webhookEndpointEvents.idempotencyKey, input.idempotencyKey))).limit(1);
      const [endpoint] = await tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId)).limit(1);
      if (!endpoint) throw new NotFoundException("Webhook endpoint not found");
      if (event) return endpoint;
      if (endpoint.version !== input.expectedVersion) throw new ConflictException("Webhook endpoint version changed");
      const [updated] = await tx.update(webhookEndpoints).set({ url: input.url, eventTypes: input.eventTypes, maxAttempts: input.maxAttempts, status: input.status, version: endpoint.version + 1, updatedAt: new Date() }).where(eq(webhookEndpoints.id, endpointId)).returning();
      await appendEndpointEvent(tx, context, updated!, "updated", input.reasonCode, input.idempotencyKey);
      return updated!;
    });
    return webhookEndpointView(row);
  }

  async rotateWebhookSecret(context: TenantContext, endpointId: string, rawInput: RotateWebhookSecretInput) {
    const input = RotateWebhookSecretInputSchema.parse(rawInput);
    const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `webhook-endpoint:${endpointId}`);
      const [event] = await tx.select().from(webhookEndpointEvents).where(and(eq(webhookEndpointEvents.endpointId, endpointId), eq(webhookEndpointEvents.idempotencyKey, input.idempotencyKey))).limit(1);
      const [endpoint] = await tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId)).limit(1);
      if (!endpoint) throw new NotFoundException("Webhook endpoint not found");
      if (event) return { row: endpoint, signingSecret: null };
      if (endpoint.version !== input.expectedVersion) throw new ConflictException("Webhook endpoint version changed");
      const [updated] = await tx.update(webhookEndpoints).set({ encryptedSigningSecret: this.secrets.encrypt(signingSecret), signingKeyPrefix: signingSecret.slice(0, 14), version: endpoint.version + 1, updatedAt: new Date() }).where(eq(webhookEndpoints.id, endpointId)).returning();
      await appendEndpointEvent(tx, context, updated!, "secret_rotated", input.reasonCode, input.idempotencyKey);
      return { row: updated!, signingSecret };
    });
    return CreatedWebhookEndpointViewSchema.parse({ endpoint: webhookEndpointView(result.row), signingSecret: result.signingSecret });
  }

  async publishEvent(context: TenantContext, rawInput: PublishWebhookEventInput) {
    const input = PublishWebhookEventInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `webhook-event:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(webhookEvents).where(eq(webhookEvents.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.eventType !== input.eventType || replayed.resourceId !== input.resourceId || replayed.payloadChecksum !== hash(input.payload)) throw new ConflictException("Webhook event idempotency key was reused with changed input");
        const deliveries = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, replayed.id));
        return { event: replayed, deliveries, created: false };
      }
      const eventId = createEntityId();
      const [event] = await tx.insert(webhookEvents).values({ id: eventId, tenantId: context.tenantId, eventType: input.eventType, resourceType: input.resourceType, resourceId: input.resourceId, payload: input.payload, payloadChecksum: hash(input.payload), occurredAt: new Date(input.occurredAt), idempotencyKey: input.idempotencyKey, recordedBy: context.userId }).returning();
      const endpoints = (await tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.status, "active"))).filter((endpoint) => endpoint.eventTypes.includes(input.eventType));
      const deliveries = endpoints.map((endpoint) => ({ id: createEntityId(), tenantId: context.tenantId, eventId, endpointId: endpoint.id, status: "pending" as const, maxAttempts: endpoint.maxAttempts, idempotencyKey: `${eventId}:${endpoint.id}`, requestedBy: context.userId }));
      if (deliveries.length) await tx.insert(webhookDeliveries).values(deliveries);
      return { event: event!, deliveries, created: true };
    });
    const pendingDeliveries = result.deliveries.filter((delivery) => delivery.status === "pending");
    if (pendingDeliveries.length) {
      await Promise.all(pendingDeliveries.map(async (delivery) => {
        try { await this.enqueuer.enqueue({ deliveryId: delivery.id, tenantId: context.tenantId, requestedBy: context.userId, maxAttempts: delivery.maxAttempts }); }
        catch { await this.markQueueFailure(context, delivery.id); }
      }));
    }
    return WebhookEventViewSchema.parse(webhookEventView(result.event));
  }

  async replayDelivery(context: TenantContext, deliveryId: string, rawInput: ReplayWebhookDeliveryInput) {
    const input = ReplayWebhookDeliveryInputSchema.parse(rawInput);
    const delivery = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `webhook-delivery:${deliveryId}`);
      const [replayed] = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return replayed;
      const [original] = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
      if (!original) throw new NotFoundException("Webhook delivery not found");
      if (original.status !== input.expectedStatus) throw new ConflictException("Only dead-letter Webhook deliveries can be replayed");
      const [event] = await tx.select().from(webhookEvents).where(eq(webhookEvents.id, original.eventId)).limit(1);
      if (!event?.payload) throw new ConflictException("Retained Webhook event payload is unavailable for replay");
      const [created] = await tx.insert(webhookDeliveries).values({ id: createEntityId(), tenantId: context.tenantId, eventId: original.eventId, endpointId: original.endpointId, maxAttempts: original.maxAttempts, replayOfDeliveryId: original.id, idempotencyKey: input.idempotencyKey, requestedBy: context.userId }).returning();
      return created!;
    });
    try { await this.enqueuer.enqueue({ deliveryId: delivery.id, tenantId: context.tenantId, requestedBy: context.userId, maxAttempts: delivery.maxAttempts }); }
    catch { await this.markQueueFailure(context, delivery.id); throw new ServiceUnavailableException("Webhook delivery queue is unavailable"); }
    await this.audit.record(context, { action: "integration.webhook_delivery.replay", resourceType: "webhook_delivery", resourceId: delivery.id, result: "success", metadata: { replayOfDeliveryId: deliveryId, reasonCode: input.reasonCode } });
    return this.delivery(context, delivery.id);
  }

  async runRetention(context: TenantContext, rawInput: RunIntegrationRetentionInput) {
    const input = RunIntegrationRetentionInputSchema.parse(rawInput);
    const row = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `integration-retention:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(integrationRetentionRuns).where(eq(integrationRetentionRuns.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return replayed;
      const redacted = await tx.update(webhookEvents).set({ payload: null, payloadRedactedAt: new Date() }).where(and(lt(webhookEvents.recordedAt, new Date(input.payloadsBefore)), isNotNull(webhookEvents.payload))).returning({ id: webhookEvents.id, checksum: webhookEvents.payloadChecksum });
      const [created] = await tx.insert(integrationRetentionRuns).values({ id: createEntityId(), tenantId: context.tenantId, payloadsBefore: new Date(input.payloadsBefore), redactedEventCount: redacted.length, checksum: hash(redacted), idempotencyKey: input.idempotencyKey, completedBy: context.userId }).returning();
      return created!;
    });
    return retentionView(row);
  }

  async delivery(context: TenantContext, deliveryId: string): Promise<WebhookDeliveryView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [delivery] = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
      if (!delivery) throw new NotFoundException("Webhook delivery not found");
      const attempts = await tx.select().from(webhookDeliveryAttempts).where(eq(webhookDeliveryAttempts.deliveryId, deliveryId)).orderBy(asc(webhookDeliveryAttempts.attemptNumber));
      return deliveryView(delivery, attempts);
    });
  }

  async workspace(context: TenantContext): Promise<IntegrationWorkspaceView> {
    return withTenant(this.database.db, context, async (tx) => {
      const { current } = await currentIntegrationClientAuthority(tx, context, Permission.IntegrationRead), now = await integrationClientNow(tx);
      const [clients, endpoints, events, deliveries, retentionRuns] = await Promise.all([
        tx.select().from(integrationApiClients).where(permissionScope(current, Permission.IntegrationRead) === "tenant" ? undefined : eq(integrationApiClients.createdBy, current.userId)).orderBy(desc(integrationApiClients.createdAt)).limit(100),
        tx.select().from(webhookEndpoints).orderBy(desc(webhookEndpoints.updatedAt)).limit(100),
        tx.select().from(webhookEvents).orderBy(desc(webhookEvents.recordedAt)).limit(100),
        tx.select().from(webhookDeliveries).orderBy(desc(webhookDeliveries.createdAt)).limit(200),
        tx.select().from(integrationRetentionRuns).orderBy(desc(integrationRetentionRuns.completedAt)).limit(20),
      ]);
      const deliveryViews = await Promise.all(deliveries.map(async (delivery) => deliveryView(delivery, await tx.select().from(webhookDeliveryAttempts).where(eq(webhookDeliveryAttempts.deliveryId, delivery.id)).orderBy(asc(webhookDeliveryAttempts.attemptNumber)))));
      return IntegrationWorkspaceViewSchema.parse({ contextAuthority: integrationClientContextAuthority(current),
        clientAdmission: integrationClientAdmission(current), agentCatalog: integrationAgentCatalog(current),
        apiClients: clients.map(row => apiClientView(row, now)), webhookEndpoints: endpoints.map(webhookEndpointView), webhookEvents: events.map(webhookEventView), webhookDeliveries: deliveryViews, retentionRuns: retentionRuns.map(retentionView) });
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }

  private async markQueueFailure(context: TenantContext, deliveryId: string) {
    await withTenant(this.database.db, context, (tx) => tx.update(webhookDeliveries).set({ status: "dead_letter", completedAt: new Date() }).where(eq(webhookDeliveries.id, deliveryId)));
  }
}

async function appendEndpointEvent(tx: TenantTransaction, context: TenantContext, endpoint: typeof webhookEndpoints.$inferSelect, action: "created" | "updated" | "secret_rotated", reasonCode: string, idempotencyKey: string) {
  await tx.insert(webhookEndpointEvents).values({ id: createEntityId(), tenantId: context.tenantId, endpointId: endpoint.id, version: endpoint.version, action, reasonCode, configurationChecksum: hash({ url: endpoint.url, eventTypes: endpoint.eventTypes, maxAttempts: endpoint.maxAttempts, status: endpoint.status, signingKeyPrefix: endpoint.signingKeyPrefix }), idempotencyKey, actorUserId: context.userId });
}
function sameClientRequest(row: typeof integrationApiClients.$inferSelect, input: CreateIntegrationApiClientInput, requestChecksum: string) {
  if (row.delegation && row.delegationRequest) return row.delegation.requestChecksum === requestChecksum
    && integrationClientRequestChecksum(row.delegationRequest) === requestChecksum;
  if (row.delegation || row.delegationRequest || input.scopeLimits !== undefined || input.teamIds !== undefined) return false;
  // Legacy rows retain only their original fields; recovery never creates a pin.
  return row.label === input.label && stableStringify(row.scopes) === stableStringify(input.scopes)
    && (row.expiresAt?.toISOString() ?? null) === (input.expiresAt ? new Date(input.expiresAt).toISOString() : null);
}
function apiClientView(row: typeof integrationApiClients.$inferSelect, now: Date): IntegrationApiClientView {
  return IntegrationApiClientViewSchema.parse({ id: row.id, label: row.label, keyPrefix: row.keyPrefix, scopes: row.scopes,
    status: row.status, expiresAt: row.expiresAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null,
    delegation: row.delegation ?? null, credentialState: row.status === "revoked" ? "revoked"
      : row.expiresAt && row.expiresAt <= now ? "expired" : row.delegation ? "pinned" : "requires_reissue" });
}
function webhookEndpointView(row: typeof webhookEndpoints.$inferSelect): WebhookEndpointView { return WebhookEndpointViewSchema.parse({ id: row.id, label: row.label, url: row.url, eventTypes: row.eventTypes, maxAttempts: row.maxAttempts, status: row.status, version: row.version, signingKeyPrefix: row.signingKeyPrefix, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }); }
function webhookEventView(row: typeof webhookEvents.$inferSelect) { return { id: row.id, eventType: row.eventType, resourceType: row.resourceType, resourceId: row.resourceId, payloadChecksum: row.payloadChecksum, payloadAvailable: row.payload !== null, occurredAt: row.occurredAt.toISOString(), recordedAt: row.recordedAt.toISOString() }; }
function retentionView(row: typeof integrationRetentionRuns.$inferSelect) { return IntegrationRetentionRunViewSchema.parse({ id: row.id, payloadsBefore: row.payloadsBefore.toISOString(), redactedEventCount: row.redactedEventCount, checksum: row.checksum, completedAt: row.completedAt.toISOString() }); }
function deliveryView(delivery: typeof webhookDeliveries.$inferSelect, attempts: (typeof webhookDeliveryAttempts.$inferSelect)[]) { return WebhookDeliveryViewSchema.parse({ id: delivery.id, eventId: delivery.eventId, endpointId: delivery.endpointId, status: delivery.status, attemptCount: delivery.attemptCount, maxAttempts: delivery.maxAttempts, nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null, replayOfDeliveryId: delivery.replayOfDeliveryId, createdAt: delivery.createdAt.toISOString(), completedAt: delivery.completedAt?.toISOString() ?? null, attempts: attempts.map((attempt) => WebhookDeliveryAttemptViewSchema.parse({ id: attempt.id, attemptNumber: attempt.attemptNumber, requestTimestamp: attempt.requestTimestamp.toISOString(), signatureVersion: attempt.signatureVersion, responseStatus: attempt.responseStatus, outcome: attempt.outcome, failureCode: attempt.failureCode, completedAt: attempt.completedAt.toISOString() })) }); }
async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }
function hash(value: unknown) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function hashSecret(value: string) { return createHash("sha256").update(value).digest("hex"); }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`; return JSON.stringify(value); }

export interface WebhookDeliveryEnqueuer { enqueue(input: { deliveryId: string; tenantId: string; requestedBy: string; maxAttempts: number }): Promise<void> }
