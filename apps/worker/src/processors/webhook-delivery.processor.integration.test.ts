import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  migrateDatabase,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEndpoints,
  webhookEvents,
  withTenant,
} from "@yummyai/database";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleWebhookDeliveryRepository } from "./webhook-delivery.processor.js";

describe.sequential("Webhook delivery persistence", () => {
  const database = connectDatabase();
  const secrets = new SecretVault(Buffer.alloc(32, 9));
  const tenantId = createEntityId();
  const userId = createEntityId();
  const context: TenantContext = { tenantId, userId, permissions: [], dataScope: "tenant" };
  const repository = new DrizzleWebhookDeliveryRepository(database, secrets);

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      "insert into organizations (id,name,slug) values ($1,$2,$3)",
      [tenantId, "Webhook Worker", `webhook-worker-${tenantId}`],
    );
    await database.client.unsafe(
      "insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4)",
      [userId, `webhook-worker-${userId}`, `webhook-worker-${userId}@example.test`, "Webhook Worker"],
    );
  });

  afterAll(async () => database.client.end());

  it("persists retry attempts and dead-letters a delivery after exhaustion", async () => {
    const endpointId = createEntityId();
    const eventId = createEntityId();
    const deliveryId = createEntityId();
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(webhookEndpoints).values({
        id: endpointId,
        tenantId,
        label: "Retry sink",
        url: "https://example.test/hooks",
        eventTypes: ["webhook.test"],
        maxAttempts: 2,
        encryptedSigningSecret: secrets.encrypt("whsec_worker_test"),
        signingKeyPrefix: "whsec_worker",
        idempotencyKey: `worker-endpoint-${tenantId}`,
        createdBy: userId,
      });
      await tx.insert(webhookEvents).values({
        id: eventId,
        tenantId,
        eventType: "webhook.test",
        resourceType: "worker_test",
        resourceId: createEntityId(),
        payload: { safe: true },
        payloadChecksum: "a".repeat(64),
        occurredAt: new Date("2026-07-23T00:00:00.000Z"),
        idempotencyKey: `worker-event-${tenantId}`,
        recordedBy: userId,
      });
      await tx.insert(webhookDeliveries).values({
        id: deliveryId,
        tenantId,
        eventId,
        endpointId,
        maxAttempts: 2,
        idempotencyKey: `worker-delivery-${tenantId}`,
        requestedBy: userId,
      });
    });

    const first = await repository.claim(context, deliveryId);
    expect(first).toMatchObject({ attemptCount: 1, signingSecret: "whsec_worker_test" });
    await expect(repository.complete(context, first!, {
      outcome: "retryable_failure",
      responseStatus: 503,
      failureCode: "HTTP_503",
      requestTimestamp: "2026-07-23T00:01:00.000Z",
    })).resolves.toEqual({ retry: true });

    await withTenant(database.db, context, (tx) => tx.update(webhookDeliveries).set({
      nextAttemptAt: new Date("2020-01-01T00:00:00.000Z"),
    }).where(eq(webhookDeliveries.id, deliveryId)));
    const second = await repository.claim(context, deliveryId);
    expect(second?.attemptCount).toBe(2);
    await expect(repository.complete(context, second!, {
      outcome: "retryable_failure",
      responseStatus: 503,
      failureCode: "HTTP_503",
      requestTimestamp: "2026-07-23T00:02:00.000Z",
    })).resolves.toEqual({ retry: false });

    const state = await withTenant(database.db, context, async (tx) => {
      const [delivery] = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
      const attempts = await tx.select().from(webhookDeliveryAttempts)
        .where(eq(webhookDeliveryAttempts.deliveryId, deliveryId))
        .orderBy(asc(webhookDeliveryAttempts.attemptNumber));
      return { delivery, attempts };
    });
    expect(state.delivery).toMatchObject({ status: "dead_letter", attemptCount: 2, nextAttemptAt: null });
    expect(state.attempts).toHaveLength(2);
    expect(state.attempts.map((attempt) => attempt.responseStatus)).toEqual([503, 503]);
    expect(state.attempts.map((attempt) => attempt.outcome)).toEqual(["retryable_failure", "retryable_failure"]);
  });
});
