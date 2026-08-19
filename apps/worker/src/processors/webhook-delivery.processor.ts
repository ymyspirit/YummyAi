import { createHmac } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  webhookDeliveries, webhookDeliveryAttempts, webhookEndpoints, webhookEvents,
  type DatabaseConnection, type TenantTransaction, withTenant,
} from "@yummyai/database";
import { WebhookDeliveryJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import { eq, sql } from "drizzle-orm";

export interface WebhookDeliverySnapshot {
  attemptCount: number;
  deliveryId: string;
  endpointUrl: string;
  eventId: string;
  eventType: string;
  maxAttempts: number;
  occurredAt: string;
  payload: Record<string, unknown>;
  resourceId: string;
  resourceType: string;
  signingSecret: string;
}
export interface WebhookDeliveryOutcome { failureCode: string | null; outcome: "succeeded" | "retryable_failure" | "terminal_failure"; requestTimestamp: string; responseStatus: number | null }
export interface WebhookDeliveryRepository {
  claim(context: TenantContext, deliveryId: string): Promise<WebhookDeliverySnapshot | undefined>;
  complete(context: TenantContext, snapshot: WebhookDeliverySnapshot, outcome: WebhookDeliveryOutcome): Promise<{ retry: boolean }>;
}
export interface WebhookGateway { deliver(snapshot: WebhookDeliverySnapshot): Promise<WebhookDeliveryOutcome> }

export class WebhookDeliveryProcessor {
  constructor(private readonly repository: WebhookDeliveryRepository, private readonly gateway: WebhookGateway) {}
  async process(envelope: JobEnvelope) {
    const { deliveryId } = WebhookDeliveryJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = { tenantId: envelope.tenantId, userId: envelope.requestedBy, permissions: [], dataScope: "tenant" };
    const snapshot = await this.repository.claim(context, deliveryId);
    if (!snapshot) return { deliveryId, status: "ignored" };
    const outcome = await this.gateway.deliver(snapshot);
    const completed = await this.repository.complete(context, snapshot, outcome);
    if (completed.retry) throw new Error("Webhook delivery retry scheduled");
    return { deliveryId, status: outcome.outcome === "succeeded" ? "succeeded" : "dead_letter" };
  }
}

export class DrizzleWebhookDeliveryRepository implements WebhookDeliveryRepository {
  constructor(private readonly database: DatabaseConnection, private readonly secrets: SecretVault) {}

  async claim(context: TenantContext, deliveryId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      await lock(tx, deliveryId);
      const [delivery] = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
      if (!delivery || !["pending", "retry_scheduled"].includes(delivery.status) || (delivery.nextAttemptAt && delivery.nextAttemptAt > new Date())) return undefined;
      const [[endpoint], [event]] = await Promise.all([
        tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, delivery.endpointId)).limit(1),
        tx.select().from(webhookEvents).where(eq(webhookEvents.id, delivery.eventId)).limit(1),
      ]);
      const attemptCount = delivery.attemptCount + 1;
      if (!endpoint || endpoint.status !== "active" || !event?.payload) {
        const failureCode = !endpoint ? "ENDPOINT_NOT_FOUND" : endpoint.status !== "active" ? "ENDPOINT_DISABLED" : "EVENT_PAYLOAD_REDACTED";
        await tx.insert(webhookDeliveryAttempts).values({ id: createEntityId(), tenantId: context.tenantId, deliveryId, attemptNumber: attemptCount, requestTimestamp: new Date(), signatureVersion: "v1", responseStatus: null, outcome: "terminal_failure", failureCode });
        await tx.update(webhookDeliveries).set({ status: "dead_letter", attemptCount, completedAt: new Date(), nextAttemptAt: null }).where(eq(webhookDeliveries.id, deliveryId));
        return undefined;
      }
      await tx.update(webhookDeliveries).set({ status: "delivering", attemptCount, nextAttemptAt: null }).where(eq(webhookDeliveries.id, deliveryId));
      const signingSecret = this.secrets.withSecret(endpoint.encryptedSigningSecret, (secret) => secret);
      return { attemptCount, deliveryId, endpointUrl: endpoint.url, eventId: event.id, eventType: event.eventType, maxAttempts: delivery.maxAttempts, occurredAt: event.occurredAt.toISOString(), payload: event.payload, resourceId: event.resourceId, resourceType: event.resourceType, signingSecret };
    });
  }

  async complete(context: TenantContext, snapshot: WebhookDeliverySnapshot, outcome: WebhookDeliveryOutcome) {
    return withTenant(this.database.db, context, async (tx) => {
      await lock(tx, snapshot.deliveryId);
      const [delivery] = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, snapshot.deliveryId)).limit(1);
      if (!delivery || delivery.status !== "delivering" || delivery.attemptCount !== snapshot.attemptCount) return { retry: false };
      const retry = outcome.outcome === "retryable_failure" && snapshot.attemptCount < snapshot.maxAttempts;
      const status = outcome.outcome === "succeeded" ? "succeeded" : retry ? "retry_scheduled" : "dead_letter";
      const nextAttemptAt = retry ? new Date(Date.now() + Math.min(300_000, 5_000 * 2 ** (snapshot.attemptCount - 1))) : null;
      await tx.insert(webhookDeliveryAttempts).values({ id: createEntityId(), tenantId: context.tenantId, deliveryId: snapshot.deliveryId, attemptNumber: snapshot.attemptCount, requestTimestamp: new Date(outcome.requestTimestamp), signatureVersion: "v1", responseStatus: outcome.responseStatus, outcome: retry ? "retryable_failure" : outcome.outcome, failureCode: outcome.failureCode });
      await tx.update(webhookDeliveries).set({ status, nextAttemptAt, completedAt: status === "retry_scheduled" ? null : new Date() }).where(eq(webhookDeliveries.id, snapshot.deliveryId));
      return { retry };
    });
  }
}

export class HttpWebhookGateway implements WebhookGateway {
  constructor(private readonly request: typeof fetch = fetch) {}
  async deliver(snapshot: WebhookDeliverySnapshot): Promise<WebhookDeliveryOutcome> {
    const requestTimestamp = new Date().toISOString();
    const body = stableStringify({ id: snapshot.eventId, type: snapshot.eventType, occurredAt: snapshot.occurredAt, data: { resourceType: snapshot.resourceType, resourceId: snapshot.resourceId, payload: snapshot.payload } });
    const signature = createHmac("sha256", snapshot.signingSecret).update(`${requestTimestamp}.${snapshot.eventId}.${body}`).digest("hex");
    try {
      const response = await this.request(snapshot.endpointUrl, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "YummyAI-Webhooks/1.0", "X-YummyAI-Event-Id": snapshot.eventId, "X-YummyAI-Timestamp": requestTimestamp, "X-YummyAI-Signature": `v1=${signature}` }, body, signal: AbortSignal.timeout(10_000) });
      if (response.ok) return { outcome: "succeeded", responseStatus: response.status, failureCode: null, requestTimestamp };
      if ([408, 425, 429].includes(response.status) || response.status >= 500) return { outcome: "retryable_failure", responseStatus: response.status, failureCode: `HTTP_${response.status}`, requestTimestamp };
      return { outcome: "terminal_failure", responseStatus: response.status, failureCode: `HTTP_${response.status}`, requestTimestamp };
    } catch {
      return { outcome: "retryable_failure", responseStatus: null, failureCode: "NETWORK_ERROR", requestTimestamp };
    }
  }
}

async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`; return JSON.stringify(value); }
