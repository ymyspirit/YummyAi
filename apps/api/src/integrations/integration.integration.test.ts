import { SecretVault } from "@yummyai/ai-core";
import { ConflictException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, integrationApiClients, migrateDatabase, webhookDeliveries, withTenant } from "@yummyai/database";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { DatabaseApiClientContextLoader } from "../auth/tenant-context.guard.js";
import { IntegrationService } from "./integration.service.js";

describe.sequential("P3 open integration", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(); const tenantB = createEntityId();
  const userA = createEntityId(); const userB = createEntityId();
  const contextA = context(tenantA, userA); const contextB = context(tenantB, userB);
  const enqueue = vi.fn(async () => undefined);
  const service = new IntegrationService(database, new SecretVault(Buffer.alloc(32, 7)), { enqueue }, new AuditService(database));
  let token = ""; let clientId = ""; let deliveryId = ""; let eventId = "";

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [tenantA, "Integration A", `integration-a-${tenantA}`, tenantB, "Integration B", `integration-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)", [userA, `integration-a-${userA}`, `integration-a-${userA}@example.test`, "Integration A", userB, `integration-b-${userB}`, `integration-b-${userB}@example.test`, "Integration B"]);
  });
  afterAll(async () => database.client.end());

  it("creates a least-privilege API token and authenticates it without caller-selected tenancy", async () => {
    const created = await service.createApiClient(contextA, { label: "Read forecasts", scopes: ["forecast:read", "operations:read"], expiresAt: null, idempotencyKey: `integration-client-${tenantA}` });
    token = created.bearerToken!; clientId = created.client.id;
    expect(token).toMatch(/^yai_/);
    expect((await service.createApiClient(contextA, { label: "Read forecasts", scopes: ["forecast:read", "operations:read"], expiresAt: null, idempotencyKey: `integration-client-${tenantA}` })).bearerToken).toBeNull();
    await expect(service.createApiClient({ ...contextA, permissions: ["forecast:read", "integration:manage"] }, { label: "Escalated", scopes: ["finance:read"], expiresAt: null, idempotencyKey: `integration-escalation-${tenantA}` })).rejects.toBeInstanceOf(ConflictException);
    const [stored] = await database.client.unsafe<{ scopes: unknown; secret_digest: string; status: string }[]>("select scopes, secret_digest, status from integration_api_clients where id = $1", [clientId]);
    expect(stored).toMatchObject({ scopes: ["forecast:read", "operations:read"], secret_digest: createHash("sha256").update(token).digest("hex"), status: "active" });
    const loaded = await new DatabaseApiClientContextLoader(database).load(token);
    expect(loaded).toEqual({ tenantId: tenantA, userId: userA, permissions: ["forecast:read", "operations:read"], dataScope: "tenant" });
    const wrongSecret = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    expect(await new DatabaseApiClientContextLoader(database).load(wrongSecret)).toBeNull();
    const expiring = await service.createApiClient(contextA, { label: "Expiring", scopes: ["forecast:read"], expiresAt: "2027-07-23T00:00:00.000Z", idempotencyKey: `integration-expiring-${tenantA}` });
    await withTenant(database.db, contextA, (tx) => tx.update(integrationApiClients).set({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }).where(eq(integrationApiClients.id, expiring.client.id)));
    expect(await new DatabaseApiClientContextLoader(database).load(expiring.bearerToken!)).toBeNull();
  });

  it("fans out signed-delivery work, isolates tenants, and manually replays dead letters", async () => {
    const endpoint = await service.createWebhookEndpoint(contextA, { label: "Local sink", url: "http://127.0.0.1:9999/hooks", eventTypes: ["webhook.test"], maxAttempts: 3, idempotencyKey: `integration-endpoint-${tenantA}` });
    expect(endpoint.signingSecret).toMatch(/^whsec_/);
    expect((await service.createWebhookEndpoint(contextA, { label: "Local sink", url: "http://127.0.0.1:9999/hooks", eventTypes: ["webhook.test"], maxAttempts: 3, idempotencyKey: `integration-endpoint-${tenantA}` })).signingSecret).toBeNull();
    await expect(service.createWebhookEndpoint(contextA, { label: "Changed sink", url: "http://127.0.0.1:9999/hooks", eventTypes: ["webhook.test"], maxAttempts: 3, idempotencyKey: `integration-endpoint-${tenantA}` })).rejects.toBeInstanceOf(ConflictException);
    const eventInput = { eventType: "webhook.test" as const, resourceType: "integration_test", resourceId: createEntityId(), payload: { safe: true }, occurredAt: "2026-07-23T00:00:00.000Z", idempotencyKey: `integration-event-${tenantA}` };
    const event = await service.publishEvent(contextA, eventInput);
    enqueue.mockClear();
    await service.publishEvent(contextA, eventInput);
    expect(enqueue).toHaveBeenCalledTimes(1);
    await expect(service.publishEvent(contextA, { eventType: "webhook.test", resourceType: "integration_test", resourceId: event.resourceId, payload: { safe: false }, occurredAt: "2026-07-23T00:00:00.000Z", idempotencyKey: `integration-event-${tenantA}` })).rejects.toBeInstanceOf(ConflictException);
    eventId = event.id;
    const workspace = await service.workspace(contextA);
    deliveryId = workspace.webhookDeliveries[0]!.id;
    expect(workspace.webhookEvents[0]).toMatchObject({ id: event.id, payloadAvailable: true });
    expect(workspace.webhookEndpoints[0]).not.toHaveProperty("encryptedSigningSecret");
    expect((await service.workspace(contextB)).webhookEvents).toHaveLength(0);
    await withTenant(database.db, contextA, (tx) => tx.update(webhookDeliveries).set({ status: "dead_letter", completedAt: new Date() }).where(eq(webhookDeliveries.id, deliveryId)));
    const replay = await service.replayDelivery(contextA, deliveryId, { expectedStatus: "dead_letter", reasonCode: "MANUAL_RECOVERY", idempotencyKey: `integration-replay-${tenantA}` });
    expect(replay.replayOfDeliveryId).toBe(deliveryId);
    expect(enqueue).toHaveBeenCalled();
  });

  it("redacts retained payloads, preserves checksums, and revokes API access", async () => {
    const retention = await service.runRetention(contextA, { payloadsBefore: "2027-01-01T00:00:00.000Z", idempotencyKey: `integration-retention-${tenantA}` });
    expect(retention.redactedEventCount).toBeGreaterThanOrEqual(1);
    const workspace = await service.workspace(contextA);
    expect(workspace.webhookEvents.find((event) => event.id === eventId)).toMatchObject({ payloadAvailable: false });
    await expect(service.replayDelivery(contextA, deliveryId, { expectedStatus: "dead_letter", reasonCode: "TOO_LATE", idempotencyKey: `integration-replay-redacted-${tenantA}` })).rejects.toBeInstanceOf(ConflictException);
    await service.revokeApiClient(contextA, clientId, { expectedStatus: "active", reasonCode: "ROTATION", idempotencyKey: `integration-revoke-${tenantA}` });
    expect(await new DatabaseApiClientContextLoader(database).load(token)).toBeNull();
    const privileges = await withTenant(database.db, contextA, async (tx) => (await tx.execute(sql`select has_table_privilege(current_user, 'webhook_endpoint_events', 'UPDATE') as endpoint_event_update, has_table_privilege(current_user, 'webhook_delivery_attempts', 'DELETE') as attempt_delete, has_table_privilege(current_user, 'webhook_events', 'UPDATE') as event_update, has_column_privilege(current_user, 'webhook_events', 'payload', 'UPDATE') as payload_update, has_column_privilege(current_user, 'webhook_events', 'payload_checksum', 'UPDATE') as checksum_update`))[0] as Record<string, boolean>);
    expect(privileges).toEqual({ endpoint_event_update: false, attempt_delete: false, event_update: false, payload_update: true, checksum_update: false });
  });
});

function context(tenantId: string, userId: string): TenantContext { return { tenantId, userId, permissions: ["forecast:read", "operations:read", "inventory:read", "finance:read", "customer_intelligence:read", "supplier_performance:read", "order:read", "product:read", "listing:read", "integration:read", "integration:manage"], dataScope: "tenant" }; }
