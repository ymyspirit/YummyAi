import { createHmac } from "node:crypto";

import { createEntityId } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";

import { HttpWebhookGateway, WebhookDeliveryProcessor, type WebhookDeliveryOutcome, type WebhookDeliveryRepository, type WebhookDeliverySnapshot } from "./webhook-delivery.processor.js";

describe("webhook delivery", () => {
  it("signs the exact timestamp, event id, and canonical body", async () => {
    let captured: RequestInit | undefined;
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { captured = init; return new Response(null, { status: 204 }); });
    const snapshot = fixture();
    const outcome = await new HttpWebhookGateway(request as typeof fetch).deliver(snapshot);
    const headers = captured?.headers as Record<string, string>;
    const body = String(captured?.body);
    const expected = createHmac("sha256", snapshot.signingSecret).update(`${headers["X-YummyAI-Timestamp"]}.${snapshot.eventId}.${body}`).digest("hex");
    expect(headers["X-YummyAI-Signature"]).toBe(`v1=${expected}`);
    expect(outcome.outcome).toBe("succeeded");
  });

  it("classifies provider failures and asks BullMQ to retry", async () => {
    const snapshot = fixture();
    const complete = vi.fn(async (_context, _snapshot, outcome: WebhookDeliveryOutcome) => ({ retry: outcome.outcome === "retryable_failure" }));
    const repository: WebhookDeliveryRepository = { claim: vi.fn(async () => snapshot), complete };
    const gateway = { deliver: vi.fn(async () => ({ outcome: "retryable_failure" as const, responseStatus: 503, failureCode: "HTTP_503", requestTimestamp: new Date().toISOString() })) };
    const processor = new WebhookDeliveryProcessor(repository, gateway);
    await expect(processor.process(envelope(snapshot.deliveryId))).rejects.toThrow(/retry scheduled/i);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not retry terminal HTTP failures", async () => {
    const result = await new HttpWebhookGateway(vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch).deliver(fixture());
    expect(result).toMatchObject({ outcome: "terminal_failure", responseStatus: 401, failureCode: "HTTP_401" });
  });
});

function fixture(): WebhookDeliverySnapshot { return { attemptCount: 1, deliveryId: createEntityId(), endpointUrl: "https://example.test/hooks", eventId: createEntityId(), eventType: "forecast.completed", maxAttempts: 5, occurredAt: "2026-07-23T00:00:00.000Z", payload: { metric: "sales_units", value: 12 }, resourceId: createEntityId(), resourceType: "forecast_run", signingSecret: "whsec_test_secret" }; }
function envelope(deliveryId: string) { return { attempt: 0, correlationId: deliveryId, idempotencyKey: deliveryId, jobId: createEntityId(), maxAttempts: 5, payload: { deliveryId }, requestedAt: new Date().toISOString(), requestedBy: createEntityId(), tenantId: createEntityId(), traceId: `tr_${"a".repeat(32)}` }; }
